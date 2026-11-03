import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApplyRequest, Candidate, RecognitionStatus } from '../src/shared/api'
import { placeFile } from '../src/main/library/fileops'
import { LibraryService } from '../src/main/library/service'
import { QUEUE_LIMIT } from '../src/main/library/reviews'
import { downloadModel, findModel, type ModelSpec } from '../src/main/recognition/model'
import type { TaggerRunner } from '../src/main/recognition/jobs'
import { buildFilenameIndex, characterLabels, combineFilename, parseCsv, predictions } from '../src/main/recognition/tagging'

const FERN = 'fern (sousou no frieren)'
const STARK = 'stark (sousou no frieren)'

let base: string
let index: string
let inbox: string
let service: LibraryService
let statuses: RecognitionStatus[]
let suggestions: Map<string, Candidate[]>

/** Stands in for the model, answering by filename. */
const fakeRunner: TaggerRunner = (job, onMessage) => {
  queueMicrotask(() => {
    for (const image of job.images) {
      const candidates = suggestions.get(image.name)
      if (candidates) onMessage({ type: 'result', id: image.id, candidates })
      else onMessage({ type: 'image-error', id: image.id, error: 'unreadable' })
    }
    onMessage({ type: 'complete', cancelled: false })
  })
  return { cancel: () => undefined }
}

function write(relative: string, content = 'image data'): string {
  const file = path.join(index, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

function tree(): string[] {
  return (fs.readdirSync(index, { recursive: true }) as string[])
    .filter((entry) => fs.statSync(path.join(index, entry)).isFile())
    .map((entry) => entry.replaceAll('\\', '/'))
    .sort()
}

function idOf(relative: string): number {
  const id = service.library.imageIdAtPath(path.join(index, relative))
  if (id === null) throw new Error(`Not indexed: ${relative}`)
  return id
}

function request(id: number, overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return { id, name: 'Fern - 001.png', characters: [FERN], setName: null, placeInCharacters: true, placeInSet: false, ...overrides }
}

async function scanQueue(force = false): Promise<void> {
  const folder = service.library.getFolderByPath(inbox)!
  service.startRecognition({ folderId: folder.id, includeSubfolders: false, force })
  await waitForJob()
}

async function waitForJob(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const phase = service.recognition.status().phase
    if (phase === 'complete' || phase === 'error' || phase === 'cancelled') return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Job did not finish.')
}

function setUpModel(): string {
  const models = path.join(base, 'models')
  const directory = path.join(models, 'wd-swinv2-v3-627aef9')
  fs.mkdirSync(directory, { recursive: true })
  const open = (name: string, size: number) => {
    const handle = fs.openSync(path.join(directory, name), 'w')
    fs.ftruncateSync(handle, size)
    fs.closeSync(handle)
  }
  open('model.onnx', 467460978)
  open('selected_tags.csv', 308468)
  return models
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbgrove-review-')))
  index = path.join(base, 'Index')
  inbox = path.join(index, 'Inbox')
  fs.mkdirSync(inbox, { recursive: true })
  statuses = []
  suggestions = new Map()
  service = new LibraryService(
    {
      dataDir: base,
      modelRoots: [setUpModel()],
      defaults: { autoApprove: false, charactersRoot: path.join(index, 'Characters'), setsRoot: path.join(index, 'Sets') }
    },
    (event) => {
      if (event.type === 'recognition') statuses.push(event.status)
    },
    fakeRunner
  )
})

afterEach(() => {
  service.stop()
  service.library.close()
  fs.rmSync(base, { recursive: true, force: true })
})

async function watchIndex(): Promise<void> {
  service.addRoot(index)
  await service.idle()
}

describe('applying a review', () => {
  it('moves the image into its character folder without queueing it for Discord', async () => {
    write('Inbox/a.png', 'original bytes')
    await watchIndex()
    const id = idOf('Inbox/a.png')

    const outcome = await service.applyReviews([request(id)])

    expect(outcome.results).toEqual([{ id, ok: true, name: 'Fern - 001.png' }])
    expect(tree()).toEqual(['Characters/Fern/Fern - 001.png'])
    expect(fs.readFileSync(path.join(index, 'Characters/Fern/Fern - 001.png'), 'utf8')).toBe('original bytes')
    expect(idOf('Characters/Fern/Fern - 001.png')).toBe(id)
    expect(service.reviews.discordCount()).toBe(0)
  })

  it('queues the image for Discord when asked', async () => {
    write('Inbox/a.png')
    await watchIndex()
    await service.applyReviews([request(idOf('Inbox/a.png'), { queueForDiscord: true })])
    expect(service.reviews.discordCount()).toBe(1)
  })

  it('keeps the image in the character folder and copies it into the set', async () => {
    write('Inbox/a.png')
    await watchIndex()
    await service.applyReviews([request(idOf('Inbox/a.png'), { setName: 'Beach Day', placeInSet: true })])
    expect(tree()).toEqual(['Characters/Fern/Fern - 001.png', 'Sets/Beach Day/Fern - 001.png'])
    expect(service.reviews.discordCount()).toBe(0)
  })

  it('copies an image with several characters into each of their folders', async () => {
    write('Inbox/a.png')
    await watchIndex()
    await service.applyReviews([request(idOf('Inbox/a.png'), { characters: [FERN, STARK], name: 'Pair - 001.png' })])
    expect(tree()).toEqual(['Characters/Fern/Pair - 001.png', 'Characters/Stark/Pair - 001.png'])
  })

  it('keeps the set label without placing a file when the set toggle is off', async () => {
    write('Inbox/a.png')
    await watchIndex()
    await service.applyReviews([request(idOf('Inbox/a.png'), { setName: 'Beach Day', placeInSet: false })])
    expect(tree()).toEqual(['Characters/Fern/Fern - 001.png'])
  })

  it('only renames when both toggles are off', async () => {
    write('Inbox/a.png')
    await watchIndex()
    await service.applyReviews([request(idOf('Inbox/a.png'), { placeInCharacters: false })])
    expect(tree()).toEqual(['Inbox/Fern - 001.png'])
  })

  it('never overwrites a file already using the name', async () => {
    write('Inbox/a.png', 'new')
    write('Characters/Fern/Fern - 001.png', 'existing')
    await watchIndex()
    const outcome = await service.applyReviews([request(idOf('Inbox/a.png'))])
    expect(outcome.results[0]!.name).toBe('Fern - 001 (2).png')
    expect(fs.readFileSync(path.join(index, 'Characters/Fern/Fern - 001.png'), 'utf8')).toBe('existing')
    expect(fs.readFileSync(path.join(index, 'Characters/Fern/Fern - 001 (2).png'), 'utf8')).toBe('new')
  })

  it('leaves an image already in its character folder there', async () => {
    write('Characters/Fern/old.png')
    await watchIndex()
    await service.applyReviews([request(idOf('Characters/Fern/old.png'), { characters: [FERN, STARK] })])
    expect(tree()).toEqual(['Characters/Fern/Fern - 001.png', 'Characters/Stark/Fern - 001.png'])
  })

  it('refuses a destination outside the watched folders and leaves the file alone', async () => {
    write('Inbox/a.png')
    service.library.setSetting('charactersRoot', path.join(base, 'Elsewhere'))
    await watchIndex()
    const id = idOf('Inbox/a.png')
    const outcome = await service.applyReviews([request(id)])
    expect(outcome.results[0]).toMatchObject({ ok: false })
    expect(outcome.results[0]!.error).toMatch(/inside a watched folder/)
    expect(outcome.undoToken).toBeNull()
    expect(tree()).toEqual(['Inbox/a.png'])
    expect(fs.existsSync(path.join(base, 'Elsewhere'))).toBe(false)
    expect(service.reviews.discordCount()).toBe(0)
  })

  it('refuses an image that changed since it was indexed', async () => {
    const file = write('Inbox/a.png')
    await watchIndex()
    const id = idOf('Inbox/a.png')
    fs.utimesSync(file, new Date(2021, 0, 1), new Date(2021, 0, 1))
    const outcome = await service.applyReviews([request(id)])
    expect(outcome.results[0]!.error).toMatch(/changed/)
    expect(tree()).toEqual(['Inbox/a.png'])
  })

  it('rejects unsafe filenames and a changed extension', async () => {
    write('Inbox/a.png')
    await watchIndex()
    const id = idOf('Inbox/a.png')
    for (const name of ['..\\..\\evil.png', 'a/b.png', 'con.png', 'a.jpg', 'trailing.png ']) {
      const outcome = await service.applyReviews([request(id, { name })])
      expect(outcome.results[0]!.ok, name).toBe(false)
    }
    expect(tree()).toEqual(['Inbox/a.png'])
  })

  it('reverses everything for an image when a copy fails partway', async () => {
    const source = write('Inbox/a.png')
    const targets = [
      { kind: 'character' as const, label: 'Fern', directory: path.join(index, 'Characters', 'Fern'), action: 'move' as const },
      // A file sitting where a folder is needed makes the second step fail.
      { kind: 'set' as const, label: 'Blocked', directory: path.join(write('Blocked', 'file'), 'Set'), action: 'copy' as const }
    ]
    await expect(placeFile(source, 'Fern - 001.png', targets)).rejects.toThrow()
    expect(tree()).toEqual(['Blocked', 'Inbox/a.png'])
    expect(fs.existsSync(path.join(index, 'Characters'))).toBe(false)
  })

  it('one failed image does not stop the rest of a batch', async () => {
    const changed = write('Inbox/changed.png')
    write('Inbox/fine.png')
    await watchIndex()
    const bad = idOf('Inbox/changed.png')
    const good = idOf('Inbox/fine.png')
    fs.utimesSync(changed, new Date(2021, 0, 1), new Date(2021, 0, 1))
    const outcome = await service.applyReviews([request(bad, { name: 'Fern - 001.png' }), request(good, { name: 'Fern - 002.png' })])
    expect(outcome.results.map((r) => r.ok)).toEqual([false, true])
    expect(tree()).toEqual(['Characters/Fern/Fern - 002.png', 'Inbox/changed.png'])
  })
})

describe('undo', () => {
  it('puts files, the queue, and the review back', async () => {
    write('Inbox/a.png', 'bytes')
    suggestions.set('a.png', [{ tag: FERN, score: 0.8 }])
    await watchIndex()
    await scanQueue()
    const id = idOf('Inbox/a.png')
    const before = service.reviews.list()

    const { undoToken } = await service.applyReviews([request(id, { setName: 'Beach Day', placeInSet: true, queueForDiscord: true })])
    expect(service.reviews.discordCount()).toBe(1)
    expect(service.reviews.list()).toEqual([])
    await service.undo(undoToken!)

    expect(tree()).toEqual(['Inbox/a.png'])
    expect(fs.existsSync(path.join(index, 'Characters'))).toBe(false)
    expect(fs.existsSync(path.join(index, 'Sets'))).toBe(false)
    expect(idOf('Inbox/a.png')).toBe(id)
    expect(service.reviews.discordCount()).toBe(0)
    expect(service.reviews.list().map((r) => [r.id, r.candidates])).toEqual(before.map((r) => [r.id, r.candidates]))
  })

  it('refuses when the file was edited after applying', async () => {
    write('Inbox/a.png')
    await watchIndex()
    const { undoToken } = await service.applyReviews([request(idOf('Inbox/a.png'))])
    fs.writeFileSync(path.join(index, 'Characters/Fern/Fern - 001.png'), 'edited since')
    await expect(service.undo(undoToken!)).rejects.toThrow(/changed/)
    expect(fs.readFileSync(path.join(index, 'Characters/Fern/Fern - 001.png'), 'utf8')).toBe('edited since')
  })

  it('refuses when something else took the old name', async () => {
    write('Inbox/a.png', 'first')
    await watchIndex()
    const { undoToken } = await service.applyReviews([request(idOf('Inbox/a.png'))])
    write('Inbox/a.png', 'second')
    await expect(service.undo(undoToken!)).rejects.toThrow(/uses the name/)
    expect(fs.readFileSync(path.join(index, 'Inbox/a.png'), 'utf8')).toBe('second')
  })

  it('restores skipped and cleared reviews', async () => {
    write('Inbox/a.png')
    suggestions.set('a.png', [{ tag: FERN, score: 0.5 }])
    await watchIndex()
    await scanQueue()
    const id = idOf('Inbox/a.png')
    await service.undo(service.skipReviews([id]))
    expect(service.reviews.pendingCount()).toBe(1)
    await service.undo(service.clearReviews())
    expect(service.reviews.pendingCount()).toBe(1)
  })
})

describe('the review queue', () => {
  beforeEach(() => {
    suggestions.set('a.png', [{ tag: FERN, score: 0.5 }])
    suggestions.set('b.png', [{ tag: STARK, score: 0.5 }])
  })

  it('does not rescan images that are queued or finished', async () => {
    write('Inbox/a.png')
    write('Inbox/b.png')
    await watchIndex()
    await scanQueue()
    expect(service.reviews.pendingCount()).toBe(2)
    const folder = service.library.getFolderByPath(inbox)!.id
    expect(service.startRecognition({ folderId: folder, includeSubfolders: false, force: false })).toBe(0)
    service.skipReviews([idOf('Inbox/a.png')])
    expect(service.startRecognition({ folderId: folder, includeSubfolders: false, force: false })).toBe(0)
  })

  it('lets cleared images be scanned again without touching files', async () => {
    write('Inbox/a.png')
    await watchIndex()
    await scanQueue()
    service.clearReviews()
    expect(tree()).toEqual(['Inbox/a.png'])
    expect(service.reviews.pendingCount()).toBe(0)
    await scanQueue()
    expect(service.reviews.pendingCount()).toBe(1)
  })

  it('offers a rescan on request and picks up edited images', async () => {
    const file = write('Inbox/a.png')
    await watchIndex()
    await scanQueue()
    service.skipReviews([idOf('Inbox/a.png')])
    const folder = service.library.getFolderByPath(inbox)!.id
    expect(service.reviews.eligible(folder, false, true)).toHaveLength(1)
    fs.writeFileSync(file, 'edited image')
    await service.rescan()
    expect(service.reviews.eligible(folder, false, false)).toHaveLength(1)
  })

  it('stops at the queue limit', async () => {
    for (let i = 0; i < QUEUE_LIMIT + 5; i++) write(`Inbox/${i}.png`)
    await watchIndex()
    const folder = service.library.getFolderByPath(inbox)!.id
    expect(service.reviews.eligible(folder, false, false)).toHaveLength(QUEUE_LIMIT)
    for (const image of service.reviews.eligible(folder, false, false).slice(0, 150)) service.reviews.setResult(image.id, [], null)
    expect(service.reviews.eligible(folder, false, false)).toHaveLength(50)
  })

  it('keeps recognition errors in the queue', async () => {
    write('Inbox/broken.png')
    await watchIndex()
    await scanQueue()
    expect(service.reviews.list()[0]).toMatchObject({ name: 'broken.png', error: 'unreadable' })
  })

  it('saves drafts and character names', async () => {
    write('Inbox/a.png')
    await watchIndex()
    await scanQueue()
    const id = idOf('Inbox/a.png')
    const draft = { characters: [FERN], setName: 'Beach', customName: null, placeInCharacters: true, placeInSet: true }
    service.saveDrafts([{ id, draft }])
    service.saveCharacterName(FERN, 'Fern The Mage', '')
    const state = service.getReviewState()
    expect(state.items[0]!.draft).toEqual(draft)
    expect(state.names).toEqual([{ raw: FERN, name: 'Fern The Mage', series: '' }])
    expect(state.knownCharacters).toContain(FERN)
  })

  it('takes sets from the folders in the Sets folder', async () => {
    write('Sets/Winter/x.png')
    write('Sets/Beach/y.png')
    await watchIndex()
    expect(service.getReviewState().sets).toEqual(['Beach', 'Winter'])
  })
})

describe('auto-approve', () => {
  beforeEach(() => {
    suggestions.set('sure.png', [{ tag: FERN, score: 0.95 }])
    suggestions.set('unsure.png', [{ tag: FERN, score: 0.89 }])
    suggestions.set('two.png', [{ tag: FERN, score: 0.95 }, { tag: STARK, score: 0.2 }])
    suggestions.set('hint.png', [{ tag: FERN, score: 0, filenameOnly: true }])
    write('Inbox/sure.png')
    write('Inbox/unsure.png')
    write('Inbox/two.png')
    write('Inbox/hint.png')
  })

  it('does nothing when the setting is off', async () => {
    await watchIndex()
    await scanQueue()
    expect(service.reviews.pendingCount()).toBe(4)
    expect(tree().filter((f) => f.startsWith('Characters'))).toEqual([])
  })

  it('applies only a single confident match from the image', async () => {
    service.library.setSetting('autoApprove', true)
    await watchIndex()
    await scanQueue()
    expect(tree()).toContain('Characters/Fern/Fern - Sousou No Frieren - 001.png')
    expect(tree()).not.toContain('Inbox/sure.png')
    expect(service.reviews.list().map((r) => r.name).sort()).toEqual(['hint.png', 'two.png', 'unsure.png'])
    expect(statuses.at(-1)).toMatchObject({ phase: 'complete', autoApproved: 1 })
    expect(service.reviews.discordCount()).toBe(0)
  })

  it('leaves everything for review if the Characters folder is not watched', async () => {
    service.library.setSetting('autoApprove', true)
    service.library.setSetting('charactersRoot', path.join(base, 'Elsewhere'))
    await watchIndex()
    await scanQueue()
    expect(service.reviews.pendingCount()).toBe(4)
    expect(tree()).toContain('Inbox/sure.png')
  })
})

describe('recognition helpers', () => {
  const csv = 'tag_id,name,category,count\n1,general_tag,0,5\n2,"fern_(sousou_no_frieren)",4,5\n3,stark_(sousou_no_frieren),4,5\n'

  it('reads the vocabulary', () => {
    expect(parseCsv('a,"b,c"\n1,"x ""y"""\n')).toEqual([['a', 'b,c'], ['1', 'x "y"']])
    expect(characterLabels(csv).map((l) => l.tag)).toEqual(['general tag', 'fern (sousou no frieren)', 'stark (sousou no frieren)'])
    expect(() => characterLabels('name,category\nx,0\n')).toThrow(/Character vocabulary/)
  })

  it('keeps only character tags above the threshold, best first', () => {
    const labels = characterLabels(csv)
    expect(predictions([0.99, 0.4, 0.8], labels)).toEqual([
      { tag: STARK, score: expect.closeTo(0.8) },
      { tag: FERN, score: expect.closeTo(0.4) }
    ])
    expect(predictions([0.99, 0.05, 0.01], labels)).toEqual([])
    expect(() => predictions([1], labels)).toThrow(/do not match/)
  })

  it('uses names in the filename to rank and to suggest', () => {
    const fileIndex = buildFilenameIndex(characterLabels(csv))
    const model = [{ tag: STARK, score: 0.5 }, { tag: FERN, score: 0.45 }]
    const ranked = combineFilename('Fern_pinup.png', model, fileIndex)
    expect(ranked[0]).toMatchObject({ tag: FERN, score: 0.45, filenameMatch: true })
    expect(combineFilename('fern sousou no frieren 01.png', [], fileIndex)).toEqual([{ tag: FERN, score: 0, filenameMatch: true, filenameOnly: true }])
    expect(combineFilename('fernando.png', [], fileIndex)).toEqual([])
  })

  it('does not suggest a character from a single common word in the filename', () => {
    const labels = characterLabels('name,category\n"red_(pokemon)",4\n"faye_valentine",4\n')
    const fileIndex = buildFilenameIndex(labels)
    expect(combineFilename('Cozy Red Sweater.png', [], fileIndex)).toEqual([])
    expect(combineFilename('Faye Valentine 2.png', [], fileIndex)).toEqual([{ tag: 'faye valentine', score: 0, filenameMatch: true, filenameOnly: true }])
    const candidate = [{ tag: 'red (pokemon)', score: 0.4 }]
    expect(combineFilename('Red battle.png', candidate, fileIndex)[0]).toMatchObject({ tag: 'red (pokemon)', filenameMatch: true })
  })

  it('treats a saved single-word name as reliable', () => {
    const fileIndex = buildFilenameIndex(characterLabels('name,category\n"rem_(re:zero)",4\n'), [{ raw: 'rem (re:zero)', name: 'Rem' }])
    expect(combineFilename('rem 3.png', [], fileIndex)).toEqual([{ tag: 'rem (re:zero)', score: 0, filenameMatch: true, filenameOnly: true }])
  })
})

describe('the model', () => {
  const body = 'model bytes'
  const spec = (sha256: string): ModelSpec => ({ id: 'test-model', baseUrl: 'https://example.test', files: [{ name: 'model.bin', size: body.length, sha256 }] })
  const fetcher = (async () => new Response(body)) as typeof fetch
  // SHA-256 of "model bytes".
  const hash = async () => {
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(body).digest('hex')
  }

  it('finds an existing copy in any search location', () => {
    const models = setUpModel()
    expect(findModel([path.join(base, 'nothing'), models])).toBe(path.join(models, 'wd-swinv2-v3-627aef9'))
    expect(findModel([path.join(base, 'nothing')])).toBeNull()
  })

  it('downloads and verifies', async () => {
    const root = path.join(base, 'download')
    const directory = await downloadModel(root, () => undefined, undefined, spec(await hash()), fetcher)
    expect(fs.readFileSync(path.join(directory, 'model.bin'), 'utf8')).toBe(body)
  })

  it('discards a file that fails verification', async () => {
    const root = path.join(base, 'download')
    await expect(downloadModel(root, () => undefined, undefined, spec('0'.repeat(64)), fetcher)).rejects.toThrow(/verification/)
    expect(fs.readdirSync(path.join(root, 'test-model'))).toEqual([])
  })
})
