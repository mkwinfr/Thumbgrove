import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibraryService } from '../src/main/library/service'

let base: string
let index: string
let service: LibraryService

function write(relative: string, content = 'image data'): string {
  const file = path.join(index, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

const idOf = (relative: string): number => {
  const id = service.library.imageIdAtPath(path.join(index, relative))
  if (id === null) throw new Error(`Not indexed: ${relative}`)
  return id
}
const folder = (relative: string) => service.library.getFolderByPath(path.join(index, relative))
const search = (text: string): string[] =>
  service.library.listImages({ folderId: null, search: text, sort: 'name', includeSubfolders: false, offset: 0, limit: 100 }).items.map((i) => i.name)
const tree = (): string[] =>
  (fs.readdirSync(index, { recursive: true }) as string[])
    .filter((entry) => fs.statSync(path.join(index, entry)).isFile())
    .map((entry) => entry.replaceAll('\\', '/'))
    .sort()

async function watch(): Promise<void> {
  service.addRoot(index)
  await service.idle()
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbgrove-organize-')))
  index = path.join(base, 'Index')
  fs.mkdirSync(index)
  service = new LibraryService(
    {
      dataDir: base,
      modelRoots: [path.join(base, 'models')],
      defaults: { autoApprove: false, charactersRoot: path.join(index, 'Characters'), setsRoot: path.join(index, 'Sets') }
    },
    () => undefined
  )
})

afterEach(() => {
  service.stop()
  service.library.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('image actions', () => {
  it('renames an image and keeps its id, and undo puts it back', async () => {
    write('Inbox/a.png', 'bytes')
    await watch()
    const id = idOf('Inbox/a.png')
    const { results, undoToken } = await service.renameImages([{ id, name: 'Better.png' }])
    expect(results).toEqual([{ id, ok: true, name: 'Better.png' }])
    expect(tree()).toEqual(['Inbox/Better.png'])
    expect(idOf('Inbox/Better.png')).toBe(id)
    await service.undo(undoToken!)
    expect(tree()).toEqual(['Inbox/a.png'])
    expect(idOf('Inbox/a.png')).toBe(id)
  })

  it('never overwrites when renaming, and refuses a changed extension', async () => {
    write('Inbox/a.png', 'a')
    write('Inbox/b.png', 'b')
    await watch()
    const { results } = await service.renameImages([{ id: idOf('Inbox/a.png'), name: 'b.png' }])
    expect(results[0]!.name).toBe('b (2).png')
    expect(fs.readFileSync(path.join(index, 'Inbox/b.png'), 'utf8')).toBe('b')
    const bad = await service.renameImages([{ id: idOf('Inbox/b.png'), name: 'b.jpg' }])
    expect(bad.results[0]!.ok).toBe(false)
  })

  it('gives several images one base name with numbers, skipping names in use', async () => {
    write('Inbox/x.png', 'x')
    write('Inbox/y.jpg', 'y')
    write('Other/Trip - 001.png', 'taken')
    await watch()
    const ids = [idOf('Inbox/x.png'), idOf('Inbox/y.jpg')]
    await service.renameImagesToBase(ids, 'Trip')
    expect(tree()).toEqual(['Inbox/Trip - 001.jpg', 'Inbox/Trip - 002.png', 'Other/Trip - 001.png'].sort())
  })

  it('moves images into a tracked folder, and undo brings them back', async () => {
    write('Inbox/a.png', 'a')
    write('Inbox/b.png', 'b')
    write('Keep/existing.png', 'e')
    await watch()
    const ids = [idOf('Inbox/a.png'), idOf('Inbox/b.png')]
    const { undoToken } = await service.moveImages(ids, path.join(index, 'Keep'))
    expect(tree()).toEqual(['Keep/a.png', 'Keep/b.png', 'Keep/existing.png'])
    expect(idOf('Keep/a.png')).toBe(ids[0])
    await service.undo(undoToken!)
    expect(tree()).toEqual(['Inbox/a.png', 'Inbox/b.png', 'Keep/existing.png'])
  })

  it('keeps a same-named file safe when moving', async () => {
    write('Inbox/a.png', 'moving')
    write('Keep/a.png', 'existing')
    await watch()
    const { results } = await service.moveImages([idOf('Inbox/a.png')], path.join(index, 'Keep'))
    expect(results[0]!.name).toBe('a (2).png')
    expect(fs.readFileSync(path.join(index, 'Keep/a.png'), 'utf8')).toBe('existing')
  })

  it('refuses to move outside the watched folders or into an untracked folder', async () => {
    write('Inbox/a.png')
    write('Hide/b.png')
    await watch()
    const id = idOf('Inbox/a.png')
    await service.untrackFolder(folder('Hide')!.id)
    await expect(service.moveImages([id], base)).rejects.toThrow(/inside a watched/)
    await expect(service.moveImages([id], path.join(index, 'Hide'))).rejects.toThrow(/inside a watched/)
    expect(tree()).toContain('Inbox/a.png')
  })

  it('reports each image separately', async () => {
    const changed = write('Inbox/changed.png')
    write('Inbox/fine.png')
    await watch()
    const ids = [idOf('Inbox/changed.png'), idOf('Inbox/fine.png')]
    fs.utimesSync(changed, new Date(2021, 0, 1), new Date(2021, 0, 1))
    const { results } = await service.moveImages(ids, index)
    expect(results.map((r) => r.ok)).toEqual([false, true])
  })

  it('takes deleted images out of the queues', async () => {
    const file = write('Inbox/a.png')
    await watch()
    const id = idOf('Inbox/a.png')
    service.reviews.enqueueDiscord(id, ['Fern'], null)
    service.reviews.setResult(id, [], null)
    fs.rmSync(file)
    await service.afterImagesTrash([id], [file])
    expect(service.reviews.discordCount()).toBe(0)
    expect(service.reviews.pendingCount()).toBe(0)
    expect(service.library.imageFile(id)).toBeNull()
  })
})

describe('new folders', () => {
  it('creates a folder on disk and indexes it', async () => {
    write('Sets/a.png')
    await watch()
    const created = await service.createFolder(folder('Sets')!.id, 'Winter')
    expect(fs.statSync(path.join(index, 'Sets/Winter')).isDirectory()).toBe(true)
    expect(created.name).toBe('Winter')
    expect(service.library.getChildren(folder('Sets')!.id).map((f) => f.name)).toEqual(['Winter'])
  })

  it('refuses a name in use or an unsafe name', async () => {
    write('Sets/Beach/a.png')
    await watch()
    const parent = folder('Sets')!.id
    await expect(service.createFolder(parent, 'beach')).rejects.toThrow(/already there/)
    for (const name of ['', '..', 'a/b', 'con']) await expect(service.createFolder(parent, name), name).rejects.toThrow(/can't be used/)
  })
})

describe('favorites', () => {
  it('lists favorites and sorts them first, and they survive a rename', async () => {
    write('Alpha/a.png')
    write('Zed/b.png')
    await watch()
    const zed = folder('Zed')!.id
    service.setFolderFavorite(zed, true)
    const root = service.library.getRoots()[0]!.folderId
    expect(service.library.getChildren(root).map((f) => f.name)).toEqual(['Zed', 'Alpha'])
    await service.renameFolder(zed, 'Zed 2')
    expect(service.library.getFavorites().map((f) => f.name)).toEqual(['Zed 2'])
    service.setFolderFavorite(zed, false)
    expect(service.library.getFavorites()).toEqual([])
  })
})

describe('tags and search', () => {
  it('finds images by filename, tag, or folder name', async () => {
    write('Characters/Fern/one.png')
    write('Inbox/two.png')
    write('Inbox/fern pose.png')
    await watch()
    service.addImageTags([idOf('Inbox/two.png')], ['Fern Fans'])
    expect(search('fern')).toEqual(['fern pose.png', 'one.png', 'two.png'])
    expect(search('fans')).toEqual(['two.png'])
    expect(search('100%')).toEqual([])
  })

  it('adds, replaces, and lists tags without duplicates', async () => {
    write('a.png')
    write('b.png')
    await watch()
    const [a, b] = [idOf('a.png'), idOf('b.png')]
    expect(service.addImageTags([a, b], ['Beach', ' beach ', ''])).toBe(2)
    expect(service.addImageTags([a], ['BEACH'])).toBe(0)
    expect(service.getImageTags(a)).toEqual(['Beach'])
    service.setImageTags(a, ['Winter'])
    expect(service.getImageTags(a)).toEqual(['Winter'])
    expect(service.getAllTags()).toEqual(['Beach', 'Winter'])
  })

  it('tags a whole folder including its subfolders', async () => {
    write('Set/a.png')
    write('Set/Sub/b.png')
    write('Other/c.png')
    await watch()
    expect(service.addFolderTags(folder('Set')!.id, ['Trip'])).toBe(2)
    expect(search('trip')).toEqual(['a.png', 'b.png'])
  })

  it('tags survive a move and leave with a removed image', async () => {
    const file = write('Inbox/a.png')
    write('Keep/k.png')
    await watch()
    const id = idOf('Inbox/a.png')
    service.addImageTags([id], ['Sticky'])
    await service.moveImages([id], path.join(index, 'Keep'))
    expect(service.getImageTags(id)).toEqual(['Sticky'])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('tags applied images and their copies with characters and the set', async () => {
    write('Inbox/a.png')
    await watch()
    await service.applyReviews([{ id: idOf('Inbox/a.png'), name: 'Fern - 001.png', characters: ['fern (x)'], setName: 'Beach Day', placeInCharacters: true, placeInSet: true }])
    for (const place of ['Characters/Fern/Fern - 001.png', 'Sets/Beach Day/Fern - 001.png']) {
      expect(service.getImageTags(idOf(place))).toEqual(['Beach Day', 'Fern'])
    }
  })
})

describe('queue limit', () => {
  it('controls how many images a scan picks, within limits', async () => {
    for (let i = 0; i < 5; i++) write(`Inbox/${i}.png`)
    await watch()
    expect(service.library.getSettings().queueLimit).toBe(200)
    expect(service.setQueueLimit(3).queueLimit).toBe(3)
    const id = folder('Inbox')!.id
    expect(service.reviews.eligible(id, false, false, service.library.getSettings().queueLimit)).toHaveLength(3)
    for (const bad of [0, -1, 501, 2.5]) expect(() => service.setQueueLimit(bad)).toThrow(/from 1 to 500/)
  })
})


describe('a new library', () => {
  const start = (defaults: { charactersRoot: string; setsRoot: string }): LibraryService => {
    const dataDir = path.join(base, 'new-data')
    fs.mkdirSync(dataDir, { recursive: true })
    return new LibraryService({ dataDir, modelRoots: [], defaults: { autoApprove: false, ...defaults } }, () => undefined)
  }

  it('keeps its destinations inside the first watched folder only', () => {
    const fresh = start({ charactersRoot: path.join(base, 'Pictures', 'Characters'), setsRoot: path.join(base, 'Pictures', 'Sets') })
    const first = path.join(base, 'First')
    const second = path.join(base, 'Second')
    fs.mkdirSync(first)
    fs.mkdirSync(second)
    try {
      fresh.addRoot(first)
      expect(fresh.library.getSettings()).toMatchObject({ charactersRoot: path.join(first, 'Characters'), setsRoot: path.join(first, 'Sets') })
      fresh.addRoot(second)
      expect(fresh.library.getSettings()).toMatchObject({ charactersRoot: path.join(first, 'Characters'), setsRoot: path.join(first, 'Sets') })
    } finally {
      fresh.stop()
      fresh.library.close()
    }
  })

  it('leaves destinations alone when they are already in that folder', () => {
    const inside = path.join(base, 'Inside')
    fs.mkdirSync(inside)
    const fresh = start({ charactersRoot: path.join(inside, 'People'), setsRoot: path.join(inside, 'Groups') })
    try {
      fresh.addRoot(inside)
      expect(fresh.library.getSettings()).toMatchObject({ charactersRoot: path.join(inside, 'People'), setsRoot: path.join(inside, 'Groups') })
    } finally {
      fresh.stop()
      fresh.library.close()
    }
  })
})
