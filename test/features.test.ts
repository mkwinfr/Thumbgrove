import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { galleryHtml } from '../src/main/library/catalogues'
import { Library } from '../src/main/library/library'
import { LibraryService, suggestSet } from '../src/main/library/service'
import { scrub, startLog, writeLog } from '../src/main/log'
import type { TaggerRunner } from '../src/main/recognition/jobs'

let base: string
let index: string
let service: LibraryService
let scanned: string[][]

const runnerScore = { value: 0.5, tag: 'fern (x)' }

const runner: TaggerRunner = (job, onMessage) => {
  scanned.push(job.images.map((image) => image.name))
  const score = runnerScore.value
  queueMicrotask(() => {
    for (const image of job.images) onMessage({ type: 'result', id: image.id, candidates: [{ tag: runnerScore.tag, score }] })
    onMessage({ type: 'complete', cancelled: false })
  })
  return { cancel: () => undefined }
}

function write(relative: string, content: string | Buffer = 'image data'): string {
  const file = path.join(index, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

const picture = (seed: number) => sharp({ create: { width: 20, height: 30, channels: 3, background: { r: seed, g: 50, b: 100 } } }).png().toBuffer()
const idOf = (relative: string): number => service.library.imageIdAtPath(path.join(index, relative))!
const folder = (relative: string) => service.library.getFolderByPath(path.join(index, relative))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function watch(): Promise<void> {
  service.addRoot(index)
  await service.idle()
}

function setUpModel(): string {
  const models = path.join(base, 'models')
  const directory = path.join(models, 'wd-swinv2-v3-627aef9')
  fs.mkdirSync(directory, { recursive: true })
  for (const [name, size] of [['model.onnx', 467460978], ['selected_tags.csv', 308468]] as const) {
    const handle = fs.openSync(path.join(directory, name), 'w')
    fs.ftruncateSync(handle, size)
    fs.closeSync(handle)
  }
  return models
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbgrove-features-')))
  index = path.join(base, 'Index')
  fs.mkdirSync(index)
  scanned = []
  service = new LibraryService(
    {
      dataDir: base,
      modelRoots: [setUpModel()],
      autoScanDelayMs: 5,
      defaults: { autoApprove: false, charactersRoot: path.join(index, 'Characters'), setsRoot: path.join(index, 'Sets') }
    },
    () => undefined,
    runner
  )
})

afterEach(() => {
  service.stop()
  service.library.close()
  fs.rmSync(base, { recursive: true, force: true })
})

const apply = (id: number, characters: string[], setName: string | null = null, name = 'Chosen - 001.png') =>
  service.applyReviews([{ id, name, characters, setName, placeInCharacters: true, placeInSet: Boolean(setName) }])

describe('database upgrades', () => {
  it('backs up before an upgrade, keeps only the latest few, and stays usable', () => {
    service.stop()
    service.library.close()
    const file = path.join(base, 'library.db')
    for (let n = 0; n < 7; n++) {
      // Turns the library back into the previous version, so that opening it runs the upgrade again.
      const db = new DatabaseSync(file)
      db.exec('DROP TABLE auto_approvals; DROP TABLE character_corrections; DROP TABLE set_sources; ALTER TABLE catalogues DROP COLUMN cover_image_id; PRAGMA user_version = 7')
      db.close()
      const library = new Library(file, { autoApprove: false, charactersRoot: 'C:\\C', setsRoot: 'C:\\S' })
      expect(library.startupProblem).toBeNull()
      library.close()
    }
    expect(fs.readdirSync(path.join(base, 'backups')).filter((name) => name.endsWith('.db'))).toHaveLength(5)
    const db = new DatabaseSync(path.join(base, 'backups', fs.readdirSync(path.join(base, 'backups'))[0]!))
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7)
    db.close()
    service = new LibraryService({ dataDir: base, modelRoots: [], defaults: { autoApprove: false, charactersRoot: path.join(index, 'Characters'), setsRoot: path.join(index, 'Sets') } }, () => undefined, runner)
  })

  it('does not back up a brand new library', () => {
    expect(fs.existsSync(path.join(base, 'backups'))).toBe(false)
  })

  it('refuses a library from a newer version instead of damaging it', () => {
    const file = path.join(base, 'newer.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA user_version = 999')
    db.close()
    expect(() => new Library(file, { autoApprove: false, charactersRoot: 'C:\\C', setsRoot: 'C:\\S' })).toThrow(/newer version/)
  })
})

describe('the log', () => {
  it('hides anything that looks like a token', () => {
    expect(scrub('Authorization: Bot abc.def-ghi failed')).toBe('Authorization: Bot [hidden] failed')
    // Built from parts, so that this made-up value doesn't look like a real token in the source.
    const token = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcdE', 'abcdefghijklmnopqrstuvwxyz1'].join('.')
    expect(scrub(`leak ${token} end`)).toBe('leak [hidden] end')
    expect(scrub('Could not read C:\\Images\\a.png')).toBe('Could not read C:\\Images\\a.png')
  })

  it('writes lines and starts a new file when it gets large', () => {
    const folder = path.join(base, 'logs')
    startLog(folder)
    writeLog('error', 'first problem')
    expect(fs.readFileSync(path.join(folder, 'thumbgrove.log'), 'utf8')).toMatch(/ERROR first problem\n$/)
    fs.writeFileSync(path.join(folder, 'thumbgrove.log'), 'x'.repeat(3 * 1024 * 1024))
    writeLog('info', 'after')
    expect(fs.existsSync(path.join(folder, 'thumbgrove.log.old'))).toBe(true)
    expect(fs.readFileSync(path.join(folder, 'thumbgrove.log'), 'utf8')).toMatch(/INFO after/)
  })
})

describe('auto-approve history', () => {
  async function scanWith(score: number): Promise<void> {
    const original = runnerScore.value
    runnerScore.value = score
    service.startRecognition({ folderId: folder('Inbox')!.id, includeSubfolders: false, force: false })
    await wait(40)
    await service.idle()
    runnerScore.value = original
  }

  beforeEach(() => {
    service.library.setSetting('autoApprove', true)
  })

  it('records auto-approved images, and undo puts them back in review', async () => {
    write('Inbox/a.png', 'bytes')
    await watch()
    const id = idOf('Inbox/a.png')
    await scanWith(0.95)

    const placed = path.join(index, 'Characters/Fern/Fern - X - 001.png')
    expect(fs.existsSync(placed)).toBe(true)
    expect(service.getReviewState().autoApproved).toBe(1)
    const [entry] = service.getAutoApprovals()
    expect(entry).toMatchObject({ imageId: id, character: 'Fern', name: 'Fern - X - 001.png' })
    expect(service.getImageTags(id)).toEqual(['Fern'])

    expect(await service.undoAutoApprovals([entry!.id])).toEqual({ undone: 1, failed: [] })

    expect(fs.readFileSync(path.join(index, 'Inbox/a.png'), 'utf8')).toBe('bytes')
    expect(fs.existsSync(placed)).toBe(false)
    expect(service.reviews.list().map((r) => r.id)).toEqual([id])
    expect(service.reviews.discordCount()).toBe(0)
    expect(service.getImageTags(id)).toEqual([])
    expect(service.getAutoApprovals()).toEqual([])
  })

  it('survives a restart', async () => {
    write('Inbox/a.png')
    await watch()
    await scanWith(0.95)
    service.stop()
    service.library.close()
    service = new LibraryService({ dataDir: base, modelRoots: [setUpModel()], defaults: { autoApprove: true, charactersRoot: path.join(index, 'Characters'), setsRoot: path.join(index, 'Sets') } }, () => undefined, runner)
    expect((await service.undoAutoApprovals(null)).undone).toBe(1)
    expect(fs.existsSync(path.join(index, 'Inbox/a.png'))).toBe(true)
  })

  it('undoes everything, reporting any it can not', async () => {
    write('Inbox/a.png', 'a')
    write('Inbox/b.png', 'b')
    await watch()
    await scanWith(0.95)
    fs.writeFileSync(path.join(index, 'Characters/Fern/Fern - X - 001.png'), 'edited afterward')
    const result = await service.undoAutoApprovals(null)
    expect(result.undone).toBe(1)
    expect(result.failed[0]).toMatch(/changed/)
    expect(service.getAutoApprovals()).toHaveLength(1)
  })

  it('clearing forgets the history and leaves the files', async () => {
    write('Inbox/a.png')
    await watch()
    await scanWith(0.95)
    service.clearAutoApprovals()
    expect(service.getAutoApprovals()).toEqual([])
    expect(fs.existsSync(path.join(index, 'Characters/Fern/Fern - X - 001.png'))).toBe(true)
  })

  it('does not record images applied by hand', async () => {
    write('Inbox/a.png')
    await watch()
    service.library.setSetting('autoApprove', false)
    await apply(idOf('Inbox/a.png'), ['Fern'])
    expect(service.getAutoApprovals()).toEqual([])
  })

  it('undoing a hand-applied image removes the tags it added but keeps older ones', async () => {
    write('Inbox/a.png')
    await watch()
    const id = idOf('Inbox/a.png')
    service.addImageTags([id], ['Old', 'Fern'])
    const { undoToken } = await apply(id, ['Fern'], 'Beach')
    expect(service.getImageTags(id)).toEqual(['Beach', 'Fern', 'Old'])
    await service.undo(undoToken!)
    expect(service.getImageTags(id)).toEqual(['Fern', 'Old'])
  })
})

describe('keeping names in sync', () => {
  const THREAD = '100000000000000011'

  it('renaming a character folder in the tree carries its link, tags, and name', async () => {
    write('Characters/Fern/a.png')
    await watch()
    const id = idOf('Characters/Fern/a.png')
    service.addImageTags([id], ['Fern'])
    service.saveCharacterName('fern (x)', 'Fern', 'Frieren')
    service.discord.linkThread('characters', 'Fern', THREAD)
    service.reviews.enqueueDiscord(id, ['fern (x)'], null)

    await service.renameFolder(folder('Characters/Fern')!.id, 'Fern Two')

    expect(service.discord.getLinks()).toMatchObject([{ name: 'Fern Two', threadId: THREAD }])
    expect(service.getImageTags(id)).toEqual(['Fern Two'])
    expect(service.discord.getQueue()[0]!.missing).toEqual([])
    expect(service.discord.getQueue()[0]!.targets[0]).toMatchObject({ threadId: THREAD })
    expect(service.getCharacters()[0]).toMatchObject({ name: 'Fern Two', series: 'Frieren' })
  })

  it('renaming a set folder carries its link, tags, queue, and drafts', async () => {
    write('Sets/Beach/a.png')
    write('Inbox/b.png')
    await watch()
    const id = idOf('Sets/Beach/a.png')
    const queued = idOf('Inbox/b.png')
    service.addImageTags([id], ['Beach'])
    service.discord.linkThread('sets', 'Beach', THREAD)
    service.reviews.enqueueDiscord(queued, [], 'Beach')
    service.reviews.setResult(queued, [], null)
    service.saveDrafts([{ id: queued, draft: { characters: [], setName: 'Beach', customName: null, placeInCharacters: true, placeInSet: true } }])

    await service.renameFolder(folder('Sets/Beach')!.id, 'Shore')

    expect(service.discord.getLinks()).toMatchObject([{ kind: 'sets', name: 'Shore', threadId: THREAD }])
    expect(service.getImageTags(id)).toEqual(['Shore'])
    expect(service.discord.getQueue()[0]!.targets[0]).toMatchObject({ threadId: THREAD })
    expect(service.reviews.list()[0]!.draft!.setName).toBe('Shore')
  })

  it('does not touch links when renaming an unrelated folder', async () => {
    write('Other/Fern/a.png')
    await watch()
    service.discord.linkThread('characters', 'Fern', THREAD)
    await service.renameFolder(folder('Other/Fern')!.id, 'Fern Two')
    expect(service.discord.getLinks()).toMatchObject([{ name: 'Fern' }])
  })

  it('lists, renames, and merges sets', async () => {
    write('Sets/Beach/a.png', 'a')
    write('Sets/Shore/b.png', 'b')
    write('Sets/Shore/a.png', 'same name')
    await watch()
    service.discord.linkThread('sets', 'Shore', THREAD)
    expect(service.getSets().map((s) => [s.name, s.imageCount, s.threadId])).toEqual([['Beach', 1, null], ['Shore', 2, THREAD]])

    await service.renameSet('Beach', 'Coast')
    expect(fs.existsSync(path.join(index, 'Sets/Coast/a.png'))).toBe(true)
    await expect(service.renameSet('Coast', 'Shore')).rejects.toThrow(/Use Merge/)

    expect(await service.mergeSets('Shore', 'Coast')).toEqual({ moved: 2, failed: 0 })
    expect(fs.readdirSync(path.join(index, 'Sets/Coast')).sort()).toEqual(['a (2).png', 'a.png', 'b.png'])
    expect(fs.existsSync(path.join(index, 'Sets/Shore'))).toBe(false)
    expect(service.discord.getLinks()).toMatchObject([{ kind: 'sets', name: 'Coast', threadId: THREAD }])
    expect(service.getSets().map((s) => s.name)).toEqual(['Coast'])
  })
})

describe('learning from corrections', () => {
  async function review(name: string, tag: string, score = 0.5): Promise<number> {
    const id = idOf(`Inbox/${name}`)
    service.reviews.setResult(id, service.reviews.applyCorrections([{ tag, score }]), null)
    return id
  }

  it('replaces a suggestion only after the same correction twice', async () => {
    for (const n of ['a', 'b', 'c']) write(`Inbox/${n}.png`, n)
    await watch()
    await apply(await review('a.png', 'wrong (x)'), ['Right'], null, 'R1.png')
    expect(service.getCorrections()).toEqual([])
    expect(service.reviews.applyCorrections([{ tag: 'wrong (x)', score: 0.5 }])[0]!.tag).toBe('wrong (x)')
    await apply(await review('b.png', 'wrong (x)'), ['Right'], null, 'R2.png')
    expect(service.getCorrections()).toEqual([{ suggested: 'wrong (x)', chosen: 'Right', times: 2 }])
    expect(service.reviews.applyCorrections([{ tag: 'wrong (x)', score: 0.5 }])[0]).toEqual({ tag: 'Right', score: 0.5, learnedFrom: 'wrong (x)' })
  })

  it('forgets a correction when the original suggestion is accepted again', async () => {
    for (const n of ['a', 'b', 'c']) write(`Inbox/${n}.png`, n)
    await watch()
    await apply(await review('a.png', 'wrong (x)'), ['Right'], null, 'R1.png')
    await apply(await review('b.png', 'wrong (x)'), ['Right'], null, 'R2.png')
    service.forgetCorrection('wrong (x)', 'Right')
    await apply(await review('c.png', 'wrong (x)'), ['wrong (x)'], null, 'R3.png')
    expect(service.getCorrections()).toEqual([])
  })

  it('does not auto-approve a learned suggestion', async () => {
    write('Inbox/a.png')
    write('Inbox/b.png')
    write('Inbox/c.png')
    await watch()
    runnerScore.tag = 'fern (x)'
    await apply(await review('a.png', 'fern (x)'), ['Right'], null, 'R1.png')
    await apply(await review('b.png', 'fern (x)'), ['Right'], null, 'R2.png')
    service.library.setSetting('autoApprove', true)
    runnerScore.value = 0.99
    service.startRecognition({ folderId: folder('Inbox')!.id, includeSubfolders: false, force: false })
    await wait(30)
    runnerScore.value = 0.5
    expect(fs.existsSync(path.join(index, 'Inbox/c.png'))).toBe(true)
    expect(service.reviews.list()[0]!.candidates[0]).toMatchObject({ tag: 'Right', learnedFrom: 'fern (x)' })
  })

  it('can be turned off', async () => {
    write('Inbox/a.png')
    write('Inbox/b.png')
    write('Inbox/c.png')
    await watch()
    await apply(await review('a.png', 'fern (x)'), ['Right'], null, 'R1.png')
    await apply(await review('b.png', 'fern (x)'), ['Right'], null, 'R2.png')
    service.updateSettings({ learnCorrections: false })
    service.startRecognition({ folderId: folder('Inbox')!.id, includeSubfolders: false, force: false })
    await wait(30)
    expect(service.reviews.list()[0]!.candidates[0]).toMatchObject({ tag: 'fern (x)' })
  })
})

describe('suggesting sets', () => {
  const sources = new Map<string, string>()

  it('uses the folder name, then the filename, and never partial words', () => {
    const sets = ['Beach', 'Beach Day', 'Art']
    expect(suggestSet('C:\\D\\Beach Day 2026', 'x.png', sets, sources)).toBe('Beach Day')
    expect(suggestSet('C:\\D\\Inbox', 'fern_beach_01.png', sets, sources)).toBe('Beach')
    expect(suggestSet('C:\\D\\Inbox', 'partial.png', sets, sources)).toBeNull()
    expect(suggestSet('C:\\D\\Inbox', 'x.png', [], sources)).toBeNull()
  })

  it('prefers what you applied to images from this folder before', async () => {
    write('Sets/Beach/x.png')
    write('Inbox/a.png')
    write('Inbox/b.png')
    await watch()
    service.reviews.setResult(idOf('Inbox/b.png'), [], null)
    expect(service.getReviewState().items[0]!.suggestedSet).toBeNull()
    await apply(idOf('Inbox/a.png'), ['Fern'], 'Beach')
    expect(service.getReviewState().items[0]!.suggestedSet).toBe('Beach')
    expect(service.getReviewState().items[0]!.draft).toBeNull()
  })
})

describe('catalogue order and cover', () => {
  it('reorders images and keeps that order', async () => {
    for (const n of ['a', 'b', 'c', 'd']) write(`${n}.png`, n)
    await watch()
    const { id } = service.createCatalogue('Best', '')
    const ids = ['a', 'b', 'c', 'd'].map((n) => idOf(`${n}.png`))
    service.addToCatalogue(id, ids)
    const order = () => service.listCatalogueImages(id, 0, 10).items.map((i) => i.name[0]).join('')
    service.moveInCatalogue(id, ids[3]!, ids[0]!)
    expect(order()).toBe('dabc')
    service.moveInCatalogue(id, ids[3]!, null)
    expect(order()).toBe('abcd')
    service.moveInCatalogue(id, 99999, ids[0]!)
    expect(order()).toBe('abcd')
    service.addToCatalogue(id, [idOf('a.png')])
    expect(order()).toBe('abcd')
  })

  it('uses a chosen cover, falling back to the first image', async () => {
    write('a.png', 'a')
    const file = write('b.png', 'b')
    await watch()
    const { id } = service.createCatalogue('Best', '')
    service.addToCatalogue(id, [idOf('a.png'), idOf('b.png')])
    const b = idOf('b.png')
    service.setCatalogueCover(id, b)
    expect(service.getCatalogues()[0]!.coverId).toBe(b)
    fs.rmSync(file)
    await service.rescan()
    expect(service.getCatalogues()[0]!.coverId).toBe(idOf('a.png'))
    service.setCatalogueCover(id, null)
    expect(service.getCatalogues()[0]!.coverId).toBe(idOf('a.png'))
  })
})

describe('settings', () => {
  it('saves changes and rejects out-of-range values', () => {
    const settings = service.updateSettings({ autoApproveThreshold: 0.8, preselectThreshold: 0.6, tileSize: 220, carrySet: true, uploadLimitMb: 50 })
    expect(settings).toMatchObject({ autoApproveThreshold: 0.8, preselectThreshold: 0.6, tileSize: 220, carrySet: true, uploadLimitMb: 50 })
    expect(() => service.updateSettings({ autoApproveThreshold: 0.2 })).toThrow(/from 0.5 to 1/)
    expect(() => service.updateSettings({ preselectThreshold: 2 })).toThrow(/from 0.1 to 1/)
    expect(() => service.updateSettings({ tileSize: 5 })).toThrow(/from 110/)
    expect(() => service.updateSettings({ uploadLimitMb: -1 })).toThrow(/from 0/)
    expect(() => service.updateSettings({ queueLimit: 0 })).toThrow(/from 1 to 500/)
  })

  it('reports the version and backups', () => {
    expect(service.getAppInfo('9.9.9')).toEqual({ version: '9.9.9', dataFolder: base, backups: 0 })
  })

  it('auto-approve follows the configured confidence', async () => {
    write('Inbox/a.png')
    await watch()
    service.updateSettings({ autoApprove: true, autoApproveThreshold: 0.5 })
    service.startRecognition({ folderId: folder('Inbox')!.id, includeSubfolders: false, force: false })
    await wait(30)
    await service.idle()
    expect(fs.existsSync(path.join(index, 'Characters/Fern/Fern - X - 001.png'))).toBe(true)
  })
})

describe('automatic scanning', () => {
  it('stays off until it is turned on with a folder', async () => {
    write('Drop/a.png')
    await watch()
    service.updateSettings({ autoScanEnabled: true })
    await wait(25)
    expect(scanned).toEqual([])
  })

  it('refuses a folder outside the watched folders', async () => {
    await watch()
    expect(() => service.updateSettings({ autoScanFolder: base })).toThrow(/inside a watched/)
  })

  it('scans only the chosen folder, and new images as they arrive', async () => {
    write('Drop/a.png')
    write('Other/b.png')
    await watch()
    service.updateSettings({ autoScanEnabled: true, autoScanFolder: path.join(index, 'Drop') })
    await wait(30)
    expect(scanned).toEqual([['a.png']])

    write('Other/c.png')
    await wait(1200)
    expect(scanned).toHaveLength(1)

    write('Drop/d.png')
    await wait(1200)
    expect(scanned[1]).toEqual(['d.png'])
    expect(service.reviews.pendingCount()).toBe(2)
  })

  it('follows a change of folder, and subfolders only when asked', async () => {
    write('One/a.png')
    write('Two/b.png')
    write('Two/Sub/c.png')
    await watch()
    service.updateSettings({ autoScanEnabled: true, autoScanFolder: path.join(index, 'Two') })
    await wait(30)
    expect(scanned.flat()).toEqual(['b.png'])
    service.updateSettings({ autoScanSubfolders: true })
    await wait(30)
    expect(scanned.flat()).toEqual(['b.png', 'c.png'])
  })

  it('does not bring back images taken out with Clear queue', async () => {
    write('Drop/a.png')
    await watch()
    service.updateSettings({ autoScanEnabled: true, autoScanFolder: path.join(index, 'Drop') })
    await wait(30)
    service.clearReviews()
    service.updateSettings({ autoScanSubfolders: false })
    await wait(30)
    expect(scanned).toHaveLength(1)
    expect(service.reviews.pendingCount()).toBe(0)
  })

  it('stops when turned off', async () => {
    write('Drop/a.png')
    await watch()
    service.updateSettings({ autoScanFolder: path.join(index, 'Drop') })
    await wait(25)
    expect(scanned).toEqual([])
  })
})

describe('finding folders', () => {
  it('searches by name and path, with favorites first', async () => {
    write('Sets/Beach/a.png')
    write('Archive/Beach Old/b.png')
    await watch()
    service.setFolderFavorite(folder('Archive/Beach Old')!.id, true)
    expect(service.searchFolders('beach').map((f) => f.name)).toEqual(['Beach Old', 'Beach'])
    expect(service.searchFolders('sets').map((f) => f.name)).toEqual(['Sets', 'Beach'])
    expect(service.searchFolders('100%')).toEqual([])
  })
})

describe('characters', () => {
  it('lists saved names, folders, and suggestions together', async () => {
    write('Characters/Fern/a.png')
    write('Characters/Fern/b.png')
    write('Inbox/c.png')
    await watch()
    service.saveCharacterName('fern (x)', 'Fern', 'Frieren')
    service.reviews.setResult(idOf('Inbox/c.png'), [{ tag: 'stark (x)', score: 0.5 }], null)
    const list = service.getCharacters()
    expect(list.map((c) => c.name)).toEqual(['Fern', 'Stark'])
    expect(list[0]).toMatchObject({ raw: 'fern (x)', series: 'Frieren', imageCount: 2 })
    expect(list[1]).toMatchObject({ series: 'X', imageCount: 0, folderId: null })
  })

  it('renames a character with their folder, tags, and thread link', async () => {
    write('Characters/Fern/a.png')
    await watch()
    const id = idOf('Characters/Fern/a.png')
    const folderId = folder('Characters/Fern')!.id
    service.addImageTags([id], ['Fern'])
    service.discord.linkThread('characters', 'Fern', '100000000000000011')

    await service.updateCharacter('Fern', 'Fern the Mage', 'Frieren')

    expect(fs.existsSync(path.join(index, 'Characters/Fern The Mage/a.png'))).toBe(true)
    expect(folder('Characters/Fern The Mage')!.id).toBe(folderId)
    expect(idOf('Characters/Fern The Mage/a.png')).toBe(id)
    expect(service.getImageTags(id)).toEqual(['Fern The Mage'])
    expect(service.discord.getLinks()).toMatchObject([{ name: 'Fern The Mage', threadId: '100000000000000011' }])
    const [entry] = service.getCharacters()
    expect(entry).toMatchObject({ name: 'Fern The Mage', series: 'Frieren', threadId: '100000000000000011' })
  })

  it('changes only the series without touching files', async () => {
    write('Characters/Fern/a.png')
    await watch()
    await service.updateCharacter('Fern', 'Fern', 'Frieren')
    expect(fs.existsSync(path.join(index, 'Characters/Fern/a.png'))).toBe(true)
    expect(service.getCharacters()[0]).toMatchObject({ series: 'Frieren' })
  })

  it('refuses a rename onto an existing folder and suggests merging', async () => {
    write('Characters/Fern/a.png')
    write('Characters/Stark/b.png')
    await watch()
    await expect(service.updateCharacter('Fern', 'Stark', '')).rejects.toThrow(/Use Merge/)
    expect(fs.existsSync(path.join(index, 'Characters/Fern/a.png'))).toBe(true)
  })

  it('merges into another character without overwriting', async () => {
    write('Characters/Ferm/a.png', 'typo')
    write('Characters/Ferm/same.png', 'moving')
    write('Characters/Fern/same.png', 'existing')
    await watch()
    const id = idOf('Characters/Ferm/a.png')
    service.addImageTags([id], ['Ferm'])
    service.discord.linkThread('characters', 'Ferm', '100000000000000011')

    expect(await service.mergeCharacters('Ferm', 'Fern')).toEqual({ moved: 2, failed: 0 })

    expect(fs.readdirSync(path.join(index, 'Characters/Fern')).sort()).toEqual(['a.png', 'same (2).png', 'same.png'])
    expect(fs.readFileSync(path.join(index, 'Characters/Fern/same.png'), 'utf8')).toBe('existing')
    expect(fs.existsSync(path.join(index, 'Characters/Ferm'))).toBe(false)
    expect(idOf('Characters/Fern/a.png')).toBe(id)
    expect(service.getImageTags(id)).toEqual(['Fern'])
    expect(service.discord.getLinks()).toMatchObject([{ name: 'Fern' }])
    expect(service.getCharacters().map((c) => c.name)).toEqual(['Fern'])
  })

  it('refuses merging a character into itself', async () => {
    write('Characters/Fern/a.png')
    await watch()
    await expect(service.mergeCharacters('Fern', 'fern')).rejects.toThrow(/different character/)
  })
})

describe('duplicates', () => {
  async function findAll() {
    service.startDuplicateScan(null)
    await service.duplicatesFinished
    return service.getDuplicates(null)
  }

  it('finds identical pictures across files, even with different metadata', async () => {
    const bytes = await picture(1)
    write('Inbox/a.png', bytes)
    write('Other/b.png', await sharp(bytes).withExif({ IFD0: { Copyright: 'x' } }).png().toBuffer())
    write('Other/different.png', await picture(2))
    await watch()
    const groups = await findAll()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.images.map((i) => i.name)).toEqual(['a.png', 'b.png'])
    expect(groups[0]).toMatchObject({ width: 20, height: 30 })
  })

  it('leaves out copies in separate character and set folders', async () => {
    const bytes = await picture(3)
    write('Characters/Fern/a.png', bytes)
    write('Characters/Stark/a.png', bytes)
    write('Sets/Beach/a.png', bytes)
    await watch()
    expect(await findAll()).toEqual([])
  })

  it('still reports two copies inside one character folder', async () => {
    const bytes = await picture(4)
    write('Characters/Fern/a.png', bytes)
    write('Characters/Fern/b.png', bytes)
    await watch()
    expect(await findAll()).toHaveLength(1)
  })

  it('reports a copy outside the sorted folders', async () => {
    const bytes = await picture(5)
    write('Characters/Fern/a.png', bytes)
    write('Inbox/a.png', bytes)
    await watch()
    expect(await findAll()).toHaveLength(1)
  })

  it('can limit results to one folder, and skips unreadable files', async () => {
    const bytes = await picture(6)
    write('One/a.png', bytes)
    write('One/b.png', bytes)
    write('Two/c.png', bytes)
    write('One/broken.png', 'not an image')
    await watch()
    service.startDuplicateScan(folder('One')!.id)
    await service.duplicatesFinished
    expect(service.getDuplicates(folder('One')!.id)[0]!.images.map((i) => i.name)).toEqual(['a.png', 'b.png'])
  })

  it('never changes files', async () => {
    const bytes = await picture(7)
    const a = write('a.png', bytes)
    write('b.png', bytes)
    await watch()
    await findAll()
    expect(fs.readFileSync(a).equals(bytes)).toBe(true)
  })
})

describe('catalogues', () => {
  it('creates, renames, and refuses a duplicate or empty name', () => {
    const first = service.createCatalogue(' Best ', 'Favorites')
    service.createCatalogue('Other', '')
    expect(() => service.createCatalogue('best', '')).toThrow(/already has that name/)
    expect(() => service.createCatalogue('  ', '')).toThrow(/Enter a catalogue name/)
    service.updateCatalogue(first.id, 'Top', 'New text')
    expect(() => service.updateCatalogue(first.id, 'other', '')).toThrow(/already has that name/)
    expect(service.getCatalogues().map((c) => [c.name, c.description])).toEqual([['Other', ''], ['Top', 'New text']])
  })

  it('adds images in order without duplicates, and from whole folders', async () => {
    write('Set/a.png')
    write('Set/Sub/b.png')
    write('c.png')
    await watch()
    const { id } = service.createCatalogue('Best', '')
    expect(service.addToCatalogue(id, [idOf('c.png')])).toBe(1)
    expect(service.addToCatalogue(id, [idOf('c.png')])).toBe(0)
    expect(service.addFolderToCatalogue(id, folder('Set')!.id)).toBe(2)
    expect(service.listCatalogueImages(id, 0, 10).items.map((i) => i.name)).toEqual(['c.png', 'a.png', 'b.png'])
    const [info] = service.getCatalogues()
    expect(info).toMatchObject({ imageCount: 3, coverId: idOf('c.png') })
  })

  it('removing or deleting leaves files alone, and images keep their place when moved', async () => {
    const file = write('a.png')
    write('Keep/k.png')
    await watch()
    const id = idOf('a.png')
    const catalogue = service.createCatalogue('Best', '')
    service.addToCatalogue(catalogue.id, [id])
    await service.moveImages([id], path.join(index, 'Keep'))
    expect(service.listCatalogueImages(catalogue.id, 0, 10).items.map((i) => i.id)).toEqual([id])
    service.removeFromCatalogue(catalogue.id, [id])
    expect(service.listCatalogueImages(catalogue.id, 0, 10).total).toBe(0)
    service.deleteCatalogue(catalogue.id)
    expect(service.getCatalogues()).toEqual([])
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(path.join(index, 'Keep/a.png'))).toBe(true)
  })

  it('exports a working offline gallery with copies, never writing into an existing folder', async () => {
    write('One/same.png', 'first')
    write('Two/same.png', 'second')
    await watch()
    const { id } = service.createCatalogue('My: Best', 'Nice <things>')
    service.addToCatalogue(id, [idOf('One/same.png'), idOf('Two/same.png')])
    const out = path.join(base, 'out')
    fs.mkdirSync(out)

    service.startCatalogueExport(id, out)
    await service.exportFinished
    service.startCatalogueExport(id, out)
    await service.exportFinished

    expect(fs.readdirSync(out).sort()).toEqual(['My- Best', 'My- Best (2)'])
    const folderPath = path.join(out, 'My- Best')
    expect(fs.readdirSync(path.join(folderPath, 'images')).sort()).toEqual(['same (2).png', 'same.png'])
    expect(fs.readFileSync(path.join(folderPath, 'images', 'same.png'), 'utf8')).toBe('first')
    expect(fs.readFileSync(path.join(folderPath, 'images', 'same (2).png'), 'utf8')).toBe('second')
    const html = fs.readFileSync(path.join(folderPath, 'index.html'), 'utf8')
    expect(html).toContain('images/same%20(2).png')
    expect(html).toContain('Nice &lt;things&gt;')
    expect(html).not.toMatch(/https?:/)
    expect(fs.existsSync(path.join(index, 'One/same.png'))).toBe(true)
  })

  it('escapes names in the gallery', () => {
    const html = galleryHtml('<script>x</script>', '', ['a"b<c>.png', "it's.png"])
    expect(html).not.toContain('<script>x')
    expect(html).toContain('a&quot;b&lt;c&gt;.png')
    expect(html).toContain('images/a%22b%3Cc%3E.png')
  })
})
