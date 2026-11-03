import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibraryService } from '../src/main/library/service'
import type { TaggerRunner } from '../src/main/recognition/jobs'

let base: string
let index: string
let other: string
let service: LibraryService

const neverFinishes: TaggerRunner = () => ({ cancel: () => undefined })

function write(relative: string, content = 'image data', root = index): string {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

function folder(relative: string, root = index) {
  return service.library.getFolderByPath(path.join(root, relative))
}

function names(id: number, includeSubfolders = false): string[] {
  return service.library.listImages({ folderId: id, search: '', sort: 'name', includeSubfolders, offset: 0, limit: 100 }).items.map((i) => i.name)
}

function imageId(relative: string, root = index): number {
  return service.library.imageIdAtPath(path.join(root, relative))!
}

async function watch(root = index): Promise<void> {
  service.addRoot(root)
  await service.idle()
}

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbgrove-folder-')))
  index = path.join(base, 'Index')
  other = path.join(base, 'Other')
  fs.mkdirSync(index)
  fs.mkdirSync(other)
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

describe('renaming a folder', () => {
  it('renames on disk and keeps every id, review, and queue entry', async () => {
    write('Old/Sub/a.png')
    await watch()
    const folderId = folder('Old')!.id
    const subId = folder('Old/Sub')!.id
    const image = imageId('Old/Sub/a.png')
    service.reviews.setResult(image, [{ tag: 'fern', score: 0.5 }], null)
    service.reviews.enqueueDiscord(image, ['fern'], null)

    await service.renameFolder(folderId, 'New')
    await service.rescan()

    expect(fs.existsSync(path.join(index, 'New/Sub/a.png'))).toBe(true)
    expect(fs.existsSync(path.join(index, 'Old'))).toBe(false)
    expect(folder('New')!.id).toBe(folderId)
    expect(folder('New/Sub')!.id).toBe(subId)
    expect(imageId('New/Sub/a.png')).toBe(image)
    expect(service.library.imageFile(image)!.path).toBe(path.join(index, 'New', 'Sub', 'a.png'))
    expect(service.reviews.list().map((r) => r.id)).toEqual([image])
    expect(service.reviews.discordCount()).toBe(1)
  })

  it('allows changing only the case', async () => {
    write('fern/a.png')
    await watch()
    const id = folder('fern')!.id
    await service.renameFolder(id, 'Fern')
    expect(fs.readdirSync(index)).toEqual(['Fern'])
    expect(service.library.getFolder(id)!.name).toBe('Fern')
  })

  it('refuses a name already in use, without overwriting', async () => {
    write('A/a.png', 'first')
    write('B/b.png', 'second')
    await watch()
    await expect(service.renameFolder(folder('A')!.id, 'b')).rejects.toThrow(/already there/)
    expect(fs.readFileSync(path.join(index, 'B/b.png'), 'utf8')).toBe('second')
    expect(names(folder('A')!.id)).toEqual(['a.png'])
  })

  it('refuses unsafe names', async () => {
    write('A/a.png')
    await watch()
    const id = folder('A')!.id
    for (const name of ['', '..', 'a/b', '..\\evil', 'con', 'trailing.', 'x:y']) {
      await expect(service.renameFolder(id, name), name).rejects.toThrow(/can't be used/)
    }
    expect(fs.readdirSync(index)).toEqual(['A'])
  })
})

describe('moving a folder', () => {
  it('moves it inside a watched folder and keeps its ids', async () => {
    write('A/a.png')
    write('B/b.png')
    await watch()
    const id = folder('A')!.id
    const image = imageId('A/a.png')
    await service.moveFolder(id, path.join(index, 'B'))
    await service.rescan()
    expect(fs.existsSync(path.join(index, 'B/A/a.png'))).toBe(true)
    expect(folder('B/A')!.id).toBe(id)
    expect(imageId('B/A/a.png')).toBe(image)
    expect(folder('B')!.totalCount).toBe(2)
    expect(service.library.getRoots()[0]!.imageCount).toBe(2)
  })

  it('moves between watched folders and updates both counts', async () => {
    write('A/a.png')
    write('keep.png', 'x', other)
    await watch()
    await watch(other)
    const image = imageId('A/a.png')
    await service.moveFolder(folder('A')!.id, other)
    await service.rescan()
    expect(imageId('A/a.png', other)).toBe(image)
    const roots = Object.fromEntries(service.library.getRoots().map((r) => [r.name, r.imageCount]))
    expect(roots).toEqual({ Index: 0, Other: 2 })
  })

  it('refuses moving into itself or where it already is', async () => {
    write('A/Sub/a.png')
    await watch()
    const id = folder('A')!.id
    await expect(service.moveFolder(id, path.join(index, 'A'))).rejects.toThrow(/into itself/)
    await expect(service.moveFolder(id, path.join(index, 'A', 'Sub'))).rejects.toThrow(/into itself/)
    await expect(service.moveFolder(id, index)).rejects.toThrow(/already there/)
  })

  it('refuses a destination outside the watched folders', async () => {
    write('A/a.png')
    await watch()
    await expect(service.moveFolder(folder('A')!.id, other)).rejects.toThrow(/inside a watched folder/)
    expect(fs.existsSync(path.join(index, 'A/a.png'))).toBe(true)
  })

  it('refuses when the name is taken at the destination', async () => {
    write('A/a.png', 'moving')
    write('B/A/existing.png', 'existing')
    await watch()
    await expect(service.moveFolder(folder('A')!.id, path.join(index, 'B'))).rejects.toThrow(/already there/)
    expect(fs.readdirSync(path.join(index, 'B/A'))).toEqual(['existing.png'])
  })

  it('can move to where a deleted folder used to be', async () => {
    write('A/a.png')
    write('B/A/old.png')
    await watch()
    fs.rmSync(path.join(index, 'B/A'), { recursive: true })
    await service.rescan()
    await service.moveFolder(folder('A')!.id, path.join(index, 'B'))
    await service.rescan()
    expect(names(folder('B/A')!.id)).toEqual(['a.png'])
  })
})

describe('untracking a folder', () => {
  it('forgets the folder and leaves the files alone', async () => {
    const file = write('Keep/a.png')
    const hidden = write('Hide/Sub/b.png', 'bytes')
    await watch()
    const image = imageId('Hide/Sub/b.png')
    service.reviews.setResult(image, [], null)
    await service.untrackFolder(folder('Hide')!.id)

    expect(folder('Hide')).toBeNull()
    expect(folder('Hide/Sub')).toBeNull()
    expect(service.library.imageFile(image)).toBeNull()
    expect(service.reviews.pendingCount()).toBe(0)
    expect(service.library.getRoots()[0]!.imageCount).toBe(1)
    expect(fs.readFileSync(hidden, 'utf8')).toBe('bytes')
    expect(fs.existsSync(file)).toBe(true)
  })

  it('stays untracked through rescans and direct changes', async () => {
    write('Hide/a.png')
    await watch()
    await service.untrackFolder(folder('Hide')!.id)
    await service.rescan()
    expect(folder('Hide')).toBeNull()
    write('Hide/new.png')
    await service.rescan()
    expect(service.library.getRoots()[0]!.imageCount).toBe(0)
  })

  it('tracks again on request', async () => {
    write('Hide/a.png')
    await watch()
    await service.untrackFolder(folder('Hide')!.id)
    service.retrackFolder(path.join(index, 'Hide'))
    await service.idle()
    expect(names(folder('Hide')!.id)).toEqual(['a.png'])
    expect(service.library.getUntracked()).toEqual([])
    expect(() => service.retrackFolder(path.join(index, 'Hide'))).toThrow(/not untracked/)
  })

  it('keeps an inner folder untracked when its parent is renamed', async () => {
    write('Parent/Hide/a.png')
    write('Parent/b.png')
    await watch()
    await service.untrackFolder(folder('Parent/Hide')!.id)
    await service.renameFolder(folder('Parent')!.id, 'Renamed')
    await service.rescan()
    expect(folder('Renamed/Hide')).toBeNull()
    expect(service.library.getUntracked().map((f) => f.path)).toEqual([path.join(index, 'Renamed', 'Hide')])
    expect(names(folder('Renamed')!.id)).toEqual(['b.png'])
  })

  it('does not let files be placed in or moved to an untracked folder', async () => {
    write('Characters/Fern/x.png')
    write('Inbox/a.png')
    write('Other Folder/o.png')
    await watch()
    await service.untrackFolder(folder('Characters/Fern')!.id)
    const outcome = await service.applyReviews([{ id: imageId('Inbox/a.png'), name: 'Fern - 001.png', characters: ['Fern'], setName: null, placeInCharacters: true, placeInSet: false }])
    expect(outcome.results[0]!.ok).toBe(false)
    expect(fs.existsSync(path.join(index, 'Inbox/a.png'))).toBe(true)
    await expect(service.moveFolder(folder('Other Folder')!.id, path.join(index, 'Characters', 'Fern'))).rejects.toThrow(/inside a watched folder/)
  })

  it('offers Stop watching for a watched folder instead', async () => {
    await watch()
    await expect(service.untrackFolder(folder('.')!.id)).rejects.toThrow(/Stop watching/)
  })
})

describe('deleting a folder', () => {
  it('updates the index once the folder is in the Recycle Bin', async () => {
    write('Gone/a.png')
    write('Stay/b.png')
    await watch()
    const id = folder('Gone')!.id
    const target = service.prepareFolderDelete(id)
    expect(target).toBe(path.join(index, 'Gone'))
    // The main process sends it to the Recycle Bin. Here it's simply removed.
    fs.rmSync(target, { recursive: true })
    await service.afterFolderTrash(id)
    expect(folder('Gone')).toBeNull()
    expect(service.library.getRoots()[0]!.imageCount).toBe(1)
  })
})

describe('protected folders', () => {
  it('refuses changes to the destination folders and anything holding them', async () => {
    write('Library/Characters/a.png')
    service.library.setSetting('charactersRoot', path.join(index, 'Library', 'Characters'))
    await watch()
    for (const id of [folder('Library')!.id, folder('Library/Characters')!.id]) {
      await expect(service.renameFolder(id, 'X')).rejects.toThrow(/Characters destination/)
      await expect(service.untrackFolder(id)).rejects.toThrow(/Characters destination/)
      expect(() => service.prepareFolderDelete(id)).toThrow(/Characters destination/)
    }
    expect(fs.existsSync(path.join(index, 'Library/Characters/a.png'))).toBe(true)
  })

  it('still allows changes inside the destination folders', async () => {
    write('Characters/Fern/a.png')
    await watch()
    await service.renameFolder(folder('Characters/Fern')!.id, 'Fern Renamed')
    expect(fs.existsSync(path.join(index, 'Characters/Fern Renamed/a.png'))).toBe(true)
  })

  it('refuses watched folders', async () => {
    await watch()
    const id = service.library.getRoots()[0]!.folderId
    await expect(service.renameFolder(id, 'X')).rejects.toThrow(/Stop watching/)
    expect(() => service.prepareFolderDelete(id)).toThrow(/Stop watching/)
  })

  it('waits for a running scan before changing folders', async () => {
    service.stop()
    service.library.close()
    const models = path.join(base, 'models', 'wd-swinv2-v3-627aef9')
    fs.mkdirSync(models, { recursive: true })
    for (const [name, size] of [['model.onnx', 467460978], ['selected_tags.csv', 308468]] as const) {
      const handle = fs.openSync(path.join(models, name), 'w')
      fs.ftruncateSync(handle, size)
      fs.closeSync(handle)
    }
    service = new LibraryService(
      {
        dataDir: base,
        modelRoots: [path.join(base, 'models')],
        defaults: { autoApprove: false, charactersRoot: path.join(index, 'Characters'), setsRoot: path.join(index, 'Sets') }
      },
      () => undefined,
      neverFinishes
    )
    write('A/a.png')
    await watch()
    const id = folder('A')!.id
    service.startRecognition({ folderId: id, includeSubfolders: false, force: false })
    await expect(service.renameFolder(id, 'B')).rejects.toThrow(/Wait for/)
    expect(fs.existsSync(path.join(index, 'A/a.png'))).toBe(true)
  })
})
