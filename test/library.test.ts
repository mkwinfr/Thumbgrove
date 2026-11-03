import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { Library, naturalKey } from '../src/main/library/library'
import { scanRoot } from '../src/main/library/scanner'
import { ThumbnailQueue } from '../src/main/library/thumbnails'
import { targetsForChanges } from '../src/main/library/watcher'

const DEFAULTS = { autoApprove: true, charactersRoot: 'C:\\Characters', setsRoot: 'C:\\Sets' }

let base: string
let watched: string
let library: Library

function write(relative: string, content = 'image'): string {
  const file = path.join(watched, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

function list(folderId: number | null, overrides = {}) {
  return library.listImages({ folderId, search: '', sort: 'name', includeSubfolders: false, offset: 0, limit: 100, ...overrides })
}

function names(folderId: number | null, overrides = {}): string[] {
  return list(folderId, overrides).items.map((i) => i.name)
}

function folderId(relative: string): number {
  return library.getFolderByPath(path.join(watched, relative))!.id
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbgrove-test-')))
  watched = path.join(base, 'watched')
  fs.mkdirSync(watched)
  library = new Library(path.join(base, 'library.db'), DEFAULTS)
})

afterEach(() => {
  library.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('watched folders', () => {
  it('rejects a folder that overlaps one already watched', () => {
    fs.mkdirSync(path.join(watched, 'child'))
    library.addRoot(watched)
    expect(() => library.addRoot(watched)).toThrow(/already being watched/)
    expect(() => library.addRoot(path.join(watched, 'child'))).toThrow(/already inside/)
    expect(() => library.addRoot(base)).toThrow(/contains/)
  })

  it('indexes images recursively and ignores other files and hidden folders', async () => {
    write('a.png')
    write('notes.txt')
    write('Sets/Beach/b.JPG')
    write('.tmp.drivedownload/c.png')
    const root = library.addRoot(watched)
    const result = await scanRoot(library, root.id, null)

    expect(result.filesSeen).toBe(2)
    expect(names(root.folderId)).toEqual(['a.png'])
    expect(names(root.folderId, { includeSubfolders: true })).toEqual(['a.png', 'b.JPG'])
    expect(library.getChildren(root.folderId).map((f) => f.name)).toEqual(['Sets'])
    expect(library.getAncestors(folderId('Sets/Beach')).map((f) => f.name)).toEqual(['watched', 'Sets', 'Beach'])
  })

  it('counts images per folder and picks a cover from below when a folder has none', async () => {
    write('Sets/Beach/b.png')
    write('Sets/Beach/a.png')
    write('Sets/Snow/c.png')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)

    const sets = library.getFolder(folderId('Sets'))!
    expect(sets.imageCount).toBe(0)
    expect(sets.totalCount).toBe(3)
    expect(sets.coverId).not.toBeNull()
    expect(library.getRoots()[0]!.imageCount).toBe(3)
    const beach = library.getFolder(folderId('Sets/Beach'))!
    expect(library.imageFile(beach.coverId!)!.path.endsWith('a.png')).toBe(true)
  })

  it('removing a watched folder leaves the files on disk', async () => {
    const file = write('a.png')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    library.removeRoot(root.id)
    expect(library.getRoots()).toEqual([])
    expect(list(null).total).toBe(0)
    expect(fs.existsSync(file)).toBe(true)
  })
})

describe('keeping up with the disk', () => {
  it('never writes to the watched folder', async () => {
    write('Sets/a.png', 'original')
    const before = fs.readdirSync(watched, { recursive: true }).sort()
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    expect(fs.readdirSync(watched, { recursive: true }).sort()).toEqual(before)
    expect(fs.readFileSync(path.join(watched, 'Sets/a.png'), 'utf8')).toBe('original')
  })

  it('finds added, changed, and deleted images', async () => {
    const gone = write('gone.png')
    const changed = write('changed.png', 'one')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    const before = list(root.folderId).items.find((i) => i.name === 'changed.png')!

    fs.rmSync(gone)
    fs.writeFileSync(changed, 'longer content')
    write('new.png')
    await scanRoot(library, root.id, null)

    expect(names(root.folderId)).toEqual(['changed.png', 'new.png'])
    const after = list(root.folderId).items.find((i) => i.name === 'changed.png')!
    expect(after.id).toBe(before.id)
    expect(after.size).toBe('longer content'.length)
  })

  it('keeps an image id when the file is moved or renamed', async () => {
    const file = write('old.png', 'moved image')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    const { id } = list(root.folderId).items[0]!

    fs.mkdirSync(path.join(watched, 'Sets'))
    fs.renameSync(file, path.join(watched, 'Sets', 'renamed.png'))
    await scanRoot(library, root.id, null)

    expect(names(root.folderId)).toEqual([])
    const moved = list(folderId('Sets')).items
    expect(moved).toHaveLength(1)
    expect(moved[0]!.id).toBe(id)
    expect(moved[0]!.name).toBe('renamed.png')
    expect(library.imageFile(id)!.path).toBe(path.join(watched, 'Sets', 'renamed.png'))
  })

  it('keeps ids when a whole folder is renamed', async () => {
    write('Old/a.png', 'aaa')
    write('Old/b.png', 'bbbb')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    const ids = list(folderId('Old')).items.map((i) => i.id)

    fs.renameSync(path.join(watched, 'Old'), path.join(watched, 'New'))
    await scanRoot(library, root.id, null)

    expect(library.getChildren(root.folderId).map((f) => f.name)).toEqual(['New'])
    expect(list(folderId('New')).items.map((i) => i.id)).toEqual(ids)
  })

  it('restores an image that comes back', async () => {
    const file = write('a.png')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    const { id } = list(root.folderId).items[0]!
    fs.renameSync(file, path.join(base, 'away.png'))
    await scanRoot(library, root.id, null)
    expect(list(root.folderId).total).toBe(0)
    fs.renameSync(path.join(base, 'away.png'), file)
    await scanRoot(library, root.id, null)
    expect(list(root.folderId).items[0]!.id).toBe(id)
  })

  it('keeps the index when the watched folder is unavailable', async () => {
    write('a.png')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    fs.renameSync(watched, `${watched}-disconnected`)

    const result = await scanRoot(library, root.id, null)

    expect(result.available).toBe(false)
    expect(library.getRoots()[0]!.available).toBe(false)
    expect(list(root.folderId).total).toBe(1)
    fs.renameSync(`${watched}-disconnected`, watched)
    await scanRoot(library, root.id, null)
    expect(library.getRoots()[0]!.available).toBe(true)
  })

  it('does not treat images past the limit as deleted', async () => {
    write('a.png')
    write('b.png')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    const result = await scanRoot(library, root.id, null, { maxImages: 1 })
    expect(result.limited).toBe(true)
    expect(list(root.folderId).total).toBe(2)
  })

  it('skips images over the size limit', async () => {
    write('small.png', 'x')
    write('big.png', 'x'.repeat(50))
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null, { maxBytes: 10 })
    expect(names(root.folderId)).toEqual(['small.png'])
  })

  it('a direct rescan leaves subfolders alone', async () => {
    write('a.png')
    const nested = write('Sets/b.png')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    fs.rmSync(nested)
    write('c.png')
    await scanRoot(library, root.id, [{ path: watched, recursive: false }])
    expect(names(root.folderId)).toEqual(['a.png', 'c.png'])
    expect(list(folderId('Sets')).total).toBe(1)
  })
})

describe('listing', () => {
  it('sorts names naturally and pages through results', async () => {
    for (const name of ['Image 10.png', 'Image 2.png', 'image 1.png']) write(name)
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    expect(names(root.folderId)).toEqual(['image 1.png', 'Image 2.png', 'Image 10.png'])
    const page = list(root.folderId, { offset: 1, limit: 1 })
    expect(page.total).toBe(3)
    expect(page.items.map((i) => i.name)).toEqual(['Image 2.png'])
    expect(naturalKey('A2')).toBe('a000000000002')
  })

  it('sorts by size and date', async () => {
    const small = write('small.png', 'x')
    write('large.png', 'xxxxxxxx')
    fs.utimesSync(small, new Date(2020, 0, 1), new Date(2020, 0, 1))
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    expect(names(root.folderId, { sort: 'largest' })).toEqual(['large.png', 'small.png'])
    expect(names(root.folderId, { sort: 'oldest' })).toEqual(['small.png', 'large.png'])
    expect(names(root.folderId, { sort: 'newest' })).toEqual(['large.png', 'small.png'])
  })

  it('searches below the current folder and treats wildcards as text', async () => {
    write('Fern 1.png')
    write('Sets/Fern_2.png')
    write('Sets/Stark.png')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    expect(names(root.folderId, { search: 'FERN' })).toEqual(['Fern 1.png', 'Fern_2.png'])
    expect(names(root.folderId, { search: '_' })).toEqual(['Fern_2.png'])
    expect(names(folderId('Sets'), { search: 'fern' })).toEqual(['Fern_2.png'])
    expect(names(null, { search: 'stark' })).toEqual(['Stark.png'])
  })

  it('does not treat a folder with a similar name as a subfolder', async () => {
    write('Sets/a.png')
    write('Sets Old/b.png')
    const root = library.addRoot(watched)
    await scanRoot(library, root.id, null)
    expect(names(folderId('Sets'), { includeSubfolders: true })).toEqual(['a.png'])
  })
})

describe('settings', () => {
  it('uses defaults and remembers changes', () => {
    expect(library.getSettings()).toMatchObject({ ...DEFAULTS, queueLimit: 200, autoApproveThreshold: 0.9, autoScanEnabled: false, checkBeforeUpload: true })
    library.setSetting('autoApprove', false)
    library.setSetting('setsRoot', 'D:\\Sets')
    library.setSetting('queueLimit', 50)
    expect(library.getSettings()).toMatchObject({ ...DEFAULTS, autoApprove: false, setsRoot: 'D:\\Sets', queueLimit: 50 })
  })
})

describe('change batching', () => {
  it('narrows changes to the folders that need rescanning', () => {
    write('Sets/Beach/a.png')
    write('Sets/Beach/notes.txt')
    expect(targetsForChanges(watched, [path.join('Sets', 'Beach', 'a.png'), path.join('Sets', 'Beach', 'notes.txt')])).toEqual([
      { path: path.join(watched, 'Sets', 'Beach'), recursive: false }
    ])
  })

  it('rescans a new folder fully, including anything already covered by it', () => {
    write('Sets/Beach/a.png')
    const targets = targetsForChanges(watched, ['Sets', path.join('Sets', 'Beach'), path.join('Sets', 'Beach', 'a.png')])
    expect(targets).toEqual([{ path: path.join(watched, 'Sets'), recursive: true }])
  })

  it('checks the parent when a path disappears and ignores other file types and hidden folders', () => {
    expect(targetsForChanges(watched, [path.join('Gone', 'a.png')])).toEqual([{ path: path.join(watched, 'Gone'), recursive: true }])
    expect(targetsForChanges(watched, ['gone.txt', path.join('.tmp.driveupload', 'x.png')])).toEqual([])
  })
})

describe('thumbnails', () => {
  it('creates a small cached copy without changing the source', async () => {
    const source = path.join(base, 'source.png')
    await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#336699' } }).png().toFile(source)
    const before = fs.readFileSync(source)
    const queue = new ThumbnailQueue(path.join(base, 'cache'))

    const file = await queue.request(7, source, 123)
    const meta = await sharp(file).metadata()

    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(420)
    expect(fs.readFileSync(source).equals(before)).toBe(true)
    expect(await queue.request(7, source, 123)).toBe(file)
    expect(await queue.request(7, source, 456)).not.toBe(file)
  })

  it('reports damaged images and leaves no partial files', async () => {
    const source = path.join(base, 'broken.png')
    fs.writeFileSync(source, 'not an image')
    const cache = path.join(base, 'cache')
    await expect(new ThumbnailQueue(cache).request(1, source, 1)).rejects.toThrow()
    expect(fs.readdirSync(path.join(cache, '1'))).toEqual([])
  })
})
