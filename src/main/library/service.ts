import { existsSync, readdirSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  ApplyOutcome,
  ApplyRequest,
  ApplyResult,
  AppInfo,
  AutoApproval,
  Candidate,
  CatalogueInfo,
  CharacterEntry,
  Correction,
  Draft,
  DuplicateGroup,
  DuplicateStatus,
  FolderInfo,
  ImagePage,
  LibraryEvent,
  ReviewState,
  RootInfo,
  ScanRequest,
  SetEntry,
  Settings,
  SettingsChange,
  ThreadKind
} from '../../shared/api'
import { canonical, displayName, extensionOf, folderName, imageName, nameKey, namingBase, seriesLabel } from '../../shared/naming'
import { planPlacement } from '../../shared/placement'
import { savedFingerprint } from '../discord/remote'
import { DiscordService } from '../discord/service'
import { RecognitionJobs, type TaggerRunner } from '../recognition/jobs'
import { CatalogueStore, exportCatalogue } from './catalogues'
import { assertSafeFolderName, placeFile, undoPlacement, type PlacementJournal } from './fileops'
import { Library, MAX_QUEUE_LIMIT, pathKey, type LibraryDefaults } from './library'
import { ReviewStore, type ReviewSnapshot } from './reviews'
import { recount, scanRoot, type ScanOptions, type ScanTarget } from './scanner'
import { ThumbnailQueue } from './thumbnails'
import { RootWatcher } from './watcher'

const UNDO_DEPTH = 20
const AUTO_APPROVALS_KEPT = 500
const AUTO_SCAN_DELAY_MS = 3000
const DUPLICATE_WORKERS = 3

export interface ServiceConfig {
  dataDir: string
  defaults: LibraryDefaults
  autoScanDelayMs?: number
  /** Folders that may hold the recognition model. New downloads go in the first. */
  modelRoots: string[]
  discordApiBase?: string
  scanOptions?: Pick<ScanOptions, 'maxImages' | 'maxBytes'>
}

interface UndoEntry {
  journals: PlacementJournal[]
  rows: ReviewSnapshot[]
  queued: number[]
  /** Tags the apply added, which leave again with an undo. */
  tags: Array<{ id: number; tags: string[] }>
}

function combineUndo(items: Array<{ entry: UndoEntry }>): UndoEntry {
  return {
    journals: items.flatMap(({ entry }) => entry.journals),
    rows: items.flatMap(({ entry }) => entry.rows),
    queued: items.flatMap(({ entry }) => entry.queued),
    tags: items.flatMap(({ entry }) => entry.tags)
  }
}

const words = (text: string): string => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `

/**
 * Suggests a set from what's been done before with images from this folder, or from the folder's name
 * or the filename mentioning a set.
 */
export function suggestSet(folder: string, fileName: string, sets: string[], sources: Map<string, string>): string | null {
  const history = sources.get(pathKey(folder))
  if (history) return history
  const folderWords = words(path.basename(folder))
  const fileWords = words(fileName.replace(/\.[^.]+$/, ''))
  const longestFirst = [...sets].filter((set) => set.trim().length >= 3).sort((a, b) => b.length - a.length)
  return longestFirst.find((set) => folderWords.includes(words(set))) ?? longestFirst.find((set) => fileWords.includes(words(set))) ?? null
}

/** Owns the index, the watchers, the review queue, file placement, and thumbnails. Runs on a worker thread. */
export class LibraryService {
  readonly library: Library
  readonly reviews: ReviewStore
  readonly recognition: RecognitionJobs
  readonly discord: DiscordService
  private readonly thumbnails: ThumbnailQueue
  private readonly watchers = new Map<number, RootWatcher>()
  private readonly undoEntries = new Map<number, UndoEntry>()
  private nextUndo = 1
  private scans: Promise<unknown> = Promise.resolve()
  /** File changes run one at a time, so an undo can't overlap an apply. */
  private operations: Promise<unknown> = Promise.resolve()
  private autoScanTimer: NodeJS.Timeout | null = null
  private duplicates: DuplicateStatus = { phase: 'idle', done: 0, total: 0, failed: 0 }
  private duplicatesCancelled = false
  private exporting = false
  readonly catalogues: CatalogueStore

  constructor(
    private readonly config: ServiceConfig,
    private readonly emit: (event: LibraryEvent) => void,
    runner?: TaggerRunner
  ) {
    this.library = new Library(path.join(config.dataDir, 'library.db'), config.defaults)
    this.reviews = new ReviewStore(this.library)
    this.catalogues = new CatalogueStore(this.library)
    this.thumbnails = new ThumbnailQueue(path.join(config.dataDir, 'thumbnails'))
    this.discord = new DiscordService({
      library: this.library,
      reviews: this.reviews,
      emit,
      ...(config.discordApiBase ? { apiBase: config.discordApiBase } : {})
    })
    this.recognition = new RecognitionJobs(
      config.modelRoots,
      {
        onStatus: (status) => this.emit({ type: 'recognition', status }),
        onResult: (id, candidates, error) => {
          this.reviews.setResult(id, this.library.getSettings().learnCorrections ? this.reviews.applyCorrections(candidates) : candidates, error)
          this.emit({ type: 'reviews' })
        },
        onFinished: (results) => this.autoApprove(results),
        names: () => this.reviews.getNames()
      },
      runner
    )
  }

  /** Called at launch. The saved index is usable straight away while this catches up in the background. */
  start(): void {
    for (const root of this.library.getRoots()) this.watch(root)
    // Images added while the app was closed are picked up after this first check.
    void this.rescan().then(() => this.scheduleAutoScan(null))
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
    if (this.autoScanTimer) clearTimeout(this.autoScanTimer)
  }

  /** Resolves when every scan queued so far has finished. */
  async idle(): Promise<void> {
    await this.scans
  }

  private watch(root: RootInfo): void {
    this.watchers.get(root.id)?.stop()
    const watcher = new RootWatcher(
      root.path,
      (targets) => {
        void this.queueScan(root.id, targets).then(() => this.scheduleAutoScan(targets))
      },
      () => {
        this.watchers.delete(root.id)
        void this.queueScan(root.id, null)
      }
    )
    this.watchers.set(root.id, watcher)
    watcher.start()
  }

  /** Scans run one at a time so that they never overlap on the index. */
  private queueScan(rootId: number, targets: ScanTarget[] | null): Promise<void> {
    const next = this.scans.then(async () => {
      const root = this.library.getRoot(rootId)
      if (!root) return
      this.emit({ type: 'scan', status: { active: true, rootName: root.name, filesSeen: 0 } })
      try {
        await scanRoot(this.library, rootId, targets, {
          ...this.config.scanOptions,
          onProgress: (filesSeen) => this.emit({ type: 'scan', status: { active: true, rootName: root.name, filesSeen } }),
          onPartial: () => this.emit({ type: 'changed' })
        })
      } finally {
        this.emit({ type: 'scan', status: { active: false, rootName: root.name, filesSeen: 0 } })
        this.emit({ type: 'changed' })
      }
    })
    this.scans = next.catch(() => undefined)
    return next
  }

  addRoot(folder: string): RootInfo {
    const root = this.library.addRoot(folder)
    this.adoptDestinations(root)
    this.watch(root)
    void this.queueScan(root.id, null)
    return root
  }

  /** Review can only place files inside a watched folder, so a new library's destinations start in its first one. */
  private adoptDestinations(root: RootInfo): void {
    const settings = this.library.getSettings()
    if (this.library.getRoots().length !== 1) return
    if (settings.charactersRoot === this.config.defaults.charactersRoot && !this.rootContaining(settings.charactersRoot)) {
      this.library.setSetting('charactersRoot', path.join(root.path, 'Characters'))
    }
    if (settings.setsRoot === this.config.defaults.setsRoot && !this.rootContaining(settings.setsRoot)) {
      this.library.setSetting('setsRoot', path.join(root.path, 'Sets'))
    }
  }

  removeRoot(id: number): void {
    this.watchers.get(id)?.stop()
    this.watchers.delete(id)
    this.library.removeRoot(id)
    this.emit({ type: 'changed' })
    this.emit({ type: 'reviews' })
  }

  async rescan(): Promise<void> {
    for (const root of this.library.getRoots()) {
      // A folder that was unavailable when watching began gets another chance here.
      if (!this.watchers.has(root.id)) this.watch(root)
      await this.queueScan(root.id, null)
    }
  }

  async thumbnail(id: number): Promise<string | null> {
    const file = this.library.imageFile(id)
    return file ? this.thumbnails.request(id, file.path, file.mtimeMs) : null
  }

  // Folder actions

  /** Runs between scans, so that a scan can't see a folder halfway through changing. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operations.then(() => {
      const scanned = this.scans.then(work)
      this.scans = scanned.catch(() => undefined)
      return scanned
    })
    this.operations = next.catch(() => undefined)
    return next
  }

  private folderToChange(id: number, action: string): FolderInfo {
    const folder = this.library.getFolder(id)
    if (!folder) throw new Error('This folder is no longer available.')
    if (folder.parentId === null) throw new Error(`A watched folder can't be ${action} here. Use Stop watching instead.`)
    const settings = this.library.getSettings()
    const key = pathKey(folder.path)
    for (const [label, root] of [['Characters', settings.charactersRoot], ['Sets', settings.setsRoot]] as const) {
      const destination = pathKey(root)
      if (destination === key || destination.startsWith(`${key}\\`)) {
        throw new Error(`This folder holds your ${label} destination, so it can't be ${action}. Change it in Settings first.`)
      }
    }
    if (this.recognition.busy || ['running', 'cancelling'].includes(this.discord.getUploadStatus().phase)) {
      throw new Error('Wait for the current scan or upload to finish first.')
    }
    return folder
  }

  /** A renamed character or set folder keeps its tags, thread link, and saved name. */
  private carryFolderName(folder: FolderInfo, before: string, after: string): void {
    const settings = this.library.getSettings()
    const parent = pathKey(path.dirname(folder.path))
    if (parent === pathKey(settings.charactersRoot)) {
      this.carryCharacterName(before, after)
      for (const entry of this.reviews.getNames()) {
        if (nameKey(entry.name) === nameKey(before)) this.reviews.saveName(entry.raw, canonical(after), entry.series ?? null)
      }
    } else if (parent === pathKey(settings.setsRoot)) {
      this.carrySetName(before, after)
    }
  }

  private carryLink(kind: ThreadKind, before: string, after: string): void {
    const links = this.discord.getLinks().filter((link) => link.kind === kind)
    const link = links.find((other) => nameKey(other.name) === nameKey(before))
    if (!link) return
    this.discord.unlinkThread(kind, before)
    if (!links.some((other) => other !== link && nameKey(other.name) === nameKey(after))) this.discord.linkThread(kind, after, link.threadId, link.threadName)
  }

  private carryCharacterName(before: string, after: string): void {
    this.renameCharacterTags(before, after)
    this.carryLink('characters', before, after)
  }

  private carrySetName(before: string, after: string): void {
    this.renameCharacterTags(before, after)
    this.carryLink('sets', before, after)
    this.reviews.renameSetReferences(before, after)
  }

  private async relocate(folder: FolderInfo, destination: string, parentId: number, rootId: number): Promise<void> {
    if (path.resolve(destination) === path.resolve(folder.path)) return
    const sameFolder = pathKey(destination) === pathKey(folder.path)
    const occupied = await fsp.lstat(destination).then(() => true, () => false)
    if (occupied && !sameFolder) throw new Error(`Something named “${path.basename(destination)}” is already there.`)
    try {
      await fsp.rename(folder.path, destination)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EXDEV') throw new Error("Folders can't be moved to a different drive here.")
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') throw new Error('A file in this folder is in use. Close it and try again.')
      throw error
    }
    this.library.relocateFolder(folder.id, destination, parentId, rootId)
    recount(this.library, folder.rootId)
    if (rootId !== folder.rootId) recount(this.library, rootId)
  }

  renameFolder(id: number, name: string): Promise<void> {
    return this.exclusive(async () => {
      const folder = this.folderToChange(id, 'renamed')
      const clean = name.trim()
      assertSafeFolderName(clean)
      await this.relocate(folder, path.join(path.dirname(folder.path), clean), folder.parentId!, folder.rootId)
      if (clean !== folder.name) this.carryFolderName(folder, folder.name, clean)
      this.emit({ type: 'changed' })
      this.emit({ type: 'reviews' })
    })
  }

  moveFolder(id: number, destinationParent: string): Promise<void> {
    return this.exclusive(async () => {
      const folder = this.folderToChange(id, 'moved')
      const parent = this.library.getFolderByPath(destinationParent)
      if (!parent || this.library.isUntracked(destinationParent)) throw new Error('Choose a folder inside a watched folder.')
      if (!parent.available) throw new Error('That watched folder is not available right now.')
      const from = pathKey(folder.path)
      const to = pathKey(parent.path)
      if (to === from || to.startsWith(`${from}\\`)) throw new Error("A folder can't be moved into itself.")
      if (parent.id === folder.parentId) throw new Error('The folder is already there.')
      await this.relocate(folder, path.join(parent.path, folder.name), parent.id, parent.rootId)
      this.emit({ type: 'changed' })
      this.emit({ type: 'reviews' })
    })
  }

  untrackFolder(id: number): Promise<void> {
    return this.exclusive(async () => {
      const folder = this.folderToChange(id, 'untracked')
      this.library.untrackFolder(id)
      recount(this.library, folder.rootId)
      this.emit({ type: 'changed' })
      this.emit({ type: 'reviews' })
    })
  }

  retrackFolder(folder: string): void {
    const result = this.library.retrackFolder(folder)
    if (!result) throw new Error('This folder is not untracked.')
    void this.queueScan(result.rootId, [{ path: path.dirname(folder), recursive: true }])
  }

  /** Checks a folder may be deleted and returns its path. The main process then sends it to the Recycle Bin. */
  prepareFolderDelete(id: number): string {
    return this.folderToChange(id, 'deleted').path
  }

  async afterFolderTrash(id: number): Promise<void> {
    const folder = this.library.getFolder(id)
    if (!folder?.parentId) return
    const parent = this.library.getFolder(folder.parentId)
    if (parent) await this.queueScan(folder.rootId, [{ path: parent.path, recursive: true }])
    this.emit({ type: 'reviews' })
  }

  createFolder(parentId: number, name: string): Promise<FolderInfo> {
    return this.exclusive(async () => {
      const parent = this.library.getFolder(parentId)
      if (!parent || !parent.available) throw new Error('This folder is no longer available.')
      const clean = name.trim()
      assertSafeFolderName(clean)
      const folder = path.join(parent.path, clean)
      if (await fsp.lstat(folder).then(() => true, () => false)) throw new Error(`Something named “${clean}” is already there.`)
      await fsp.mkdir(folder)
      await scanRoot(this.library, parent.rootId, [{ path: folder, recursive: true }])
      this.emit({ type: 'changed' })
      return this.library.getFolderByPath(folder)!
    })
  }

  setFolderFavorite(id: number, on: boolean): void {
    this.library.setFolderFavorite(id, on)
    this.emit({ type: 'changed' })
  }

  // Images

  /** Renames one image. A name already in use gets a number added, so nothing is overwritten. */
  renameImages(requests: Array<{ id: number; name: string }>): Promise<ApplyOutcome> {
    return this.placeImages(requests.map(({ id, name }) => ({ id, name: () => name, directory: null })))
  }

  /** Gives several images one base name with a number each. */
  renameImagesToBase(ids: number[], base: string): Promise<ApplyOutcome> {
    const used = new Set(this.reviews.usedNames())
    return this.placeImages(
      ids.map((id) => ({
        id,
        directory: null,
        name: (current) => {
          const name = imageName(base, extensionOf(current), used)
          used.add(name.toLowerCase())
          return name
        }
      }))
    )
  }

  moveImages(ids: number[], destination: string): Promise<ApplyOutcome> {
    if (!this.rootContaining(destination) || !this.library.getFolderByPath(destination)) {
      return Promise.reject(new Error('Choose a folder inside a watched folder.'))
    }
    return this.placeImages(ids.map((id) => ({ id, name: (current) => current, directory: destination })))
  }

  private placeImages(jobs: Array<{ id: number; name(current: string): string; directory: string | null }>): Promise<ApplyOutcome> {
    return this.serialize(async () => {
      const results: ApplyResult[] = []
      const journals: PlacementJournal[] = []
      for (const job of jobs) {
        try {
          const file = this.library.imageFile(job.id)
          if (!file) throw new Error('This image is no longer available.')
          const stat = await fsp.stat(file.path, { bigint: true })
          if (Math.trunc(Number(stat.mtimeMs)) !== file.mtimeMs) throw new Error('This image changed on disk. Refresh and try again.')
          const targets = job.directory ? [{ kind: 'set' as const, label: '', directory: job.directory, action: 'move' as const }] : []
          const journal = await placeFile(file.path, job.name(path.basename(file.path)), targets)
          journals.push(journal)
          results.push({ id: job.id, ok: true, name: path.basename(journal.to) })
        } catch (error) {
          results.push({ id: job.id, ok: false, error: (error as Error).message })
        }
      }
      await this.syncFolders(
        journals.map((journal) => path.dirname(journal.from)),
        journals.map((journal) => path.dirname(journal.to))
      )
      this.emit({ type: 'reviews' })
      return { results, undoToken: journals.length ? this.remember({ journals, rows: [], queued: [], tags: [] }) : null }
    })
  }

  async afterImagesTrash(ids: number[], paths: string[]): Promise<void> {
    this.reviews.dequeueDiscord(ids)
    await this.afterTrash(ids, paths)
  }

  getImageTags(id: number): string[] {
    return this.library.getImageTags(id)
  }

  getAllTags(): string[] {
    return this.library.getAllTags()
  }

  /** Replaces one image's tags. */
  setImageTags(id: number, tags: string[]): void {
    this.library.setImageTags(id, tags)
  }

  addImageTags(ids: number[], tags: string[]): number {
    return this.library.addImageTags(ids, tags)
  }

  /** Tags every image in a folder and the folders below it. */
  addFolderTags(id: number, tags: string[]): number {
    return this.library.addImageTags(this.library.imageIdsInFolder(id), tags)
  }

  setQueueLimit(limit: number): Settings {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUEUE_LIMIT) throw new Error(`Choose a limit from 1 to ${MAX_QUEUE_LIMIT}.`)
    this.library.setSetting('queueLimit', limit)
    return this.library.getSettings()
  }

  // Settings

  updateSettings(change: SettingsChange): Settings {
    const between = (value: number, low: number, high: number, label: string): void => {
      if (!Number.isFinite(value) || value < low || value > high) throw new Error(`${label} must be from ${low} to ${high}.`)
    }
    if (change.queueLimit !== undefined) this.setQueueLimit(change.queueLimit)
    if (change.autoApproveThreshold !== undefined) between(change.autoApproveThreshold, 0.5, 1, 'Auto-approve confidence')
    if (change.preselectThreshold !== undefined) between(change.preselectThreshold, 0.1, 1, 'Suggestion confidence')
    if (change.tileSize !== undefined) between(change.tileSize, 110, 340, 'Thumbnail size')
    if (change.uploadLimitMb !== undefined) between(change.uploadLimitMb, 0, 1000, 'Upload limit')
    if (change.autoScanFolder && !this.library.getFolderByPath(change.autoScanFolder)) throw new Error('Choose a folder inside a watched folder.')
    for (const [key, value] of Object.entries(change)) {
      if (key !== 'queueLimit' && value !== undefined) this.library.setSetting(key as keyof Settings, value as string | boolean | number)
    }
    const settings = this.library.getSettings()
    this.emit({ type: 'settings', settings })
    this.scheduleAutoScan(null)
    return settings
  }

  // Automatic scanning

  /** Waits for files to finish arriving, since one drop of images produces many changes. */
  private scheduleAutoScan(targets: ScanTarget[] | null): void {
    const { autoScanEnabled, autoScanFolder } = this.library.getSettings()
    if (!autoScanEnabled || !autoScanFolder) return
    if (targets) {
      const folder = pathKey(autoScanFolder)
      const related = targets.some(({ path: target }) => {
        const key = pathKey(target)
        return key === folder || key.startsWith(`${folder}\\`) || folder.startsWith(`${key}\\`)
      })
      if (!related) return
    }
    if (this.autoScanTimer) clearTimeout(this.autoScanTimer)
    this.autoScanTimer = setTimeout(() => this.runAutoScan(), this.config.autoScanDelayMs ?? AUTO_SCAN_DELAY_MS)
  }

  private runAutoScan(): void {
    this.autoScanTimer = null
    const settings = this.library.getSettings()
    const folder = settings.autoScanEnabled && settings.autoScanFolder ? this.library.getFolderByPath(settings.autoScanFolder) : null
    if (!folder) return
    if (this.recognition.busy) {
      this.scheduleAutoScan(null)
      return
    }
    // Images taken out with Clear queue stay out until a scan is asked for by hand.
    const images = this.reviews.eligible(folder.id, settings.autoScanSubfolders, false, settings.queueLimit, true)
    if (!images.length) return
    try {
      this.recognition.start(images)
    } catch {
      // Without the model there's nothing to do yet. Scanning by hand prompts for the download.
    }
  }

  // Folder search

  searchFolders(query: string): FolderInfo[] {
    return this.library.searchFolders(query)
  }

  // Characters

  getCharacters(): CharacterEntry[] {
    const settings = this.library.getSettings()
    const names = this.reviews.getNames()
    const linkFor = new Map(this.discord.getLinks().filter((l) => l.kind === 'characters').map((l) => [nameKey(l.name), l.threadId]))
    const folders = new Map(
      (this.library.getFolderByPath(settings.charactersRoot) ? this.library.getChildren(this.library.getFolderByPath(settings.charactersRoot)!.id) : []).map((f) => [nameKey(f.name), f])
    )
    const entries = new Map<string, CharacterEntry>()
    // Saved names come first, so a tag like "fern (series)" wins over a plain folder named "Fern".
    for (const raw of [...names.map((n) => n.raw), ...this.reviews.knownCharacters(settings.charactersRoot)]) {
      const name = displayName(raw, names)
      const key = nameKey(name)
      if (entries.has(key)) continue
      const folder = folders.get(nameKey(folderName(name, 'Character')))
      entries.set(key, { key, raw, name, series: seriesLabel(raw, names), folderId: folder?.id ?? null, imageCount: folder?.totalCount ?? 0, threadId: linkFor.get(key) ?? null })
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private renameCharacterTags(from: string, to: string): void {
    if (nameKey(from) === nameKey(to)) {
      this.library.db.prepare('UPDATE image_tags SET tag = ? WHERE tag_key = ?').run(to, from.toLowerCase())
      return
    }
    this.library.db.prepare('UPDATE OR IGNORE image_tags SET tag = ?, tag_key = ? WHERE tag_key = ?').run(to, to.toLowerCase(), from.toLowerCase())
    this.library.db.prepare('DELETE FROM image_tags WHERE tag_key = ?').run(from.toLowerCase())
  }

  private characterFolder(name: string): FolderInfo | null {
    return this.library.getFolderByPath(path.join(this.library.getSettings().charactersRoot, folderName(name, 'Character')))
  }

  /** Saves a character's name and series. A new name also carries over to their folder, tags, and thread link. */
  updateCharacter(raw: string, name: string, series: string): Promise<void> {
    return this.exclusive(async () => {
      const clean = canonical(name)
      if (!clean || clean.length > 120) throw new Error('Enter a name of up to 120 characters.')
      const before = displayName(raw, this.reviews.getNames())
      if (nameKey(before) !== nameKey(clean) || before !== clean) {
        const folder = this.characterFolder(before)
        const target = path.join(this.library.getSettings().charactersRoot, folderName(clean, 'Character'))
        if (folder) {
          if (nameKey(before) !== nameKey(clean) && existsSync(target)) throw new Error(`${clean} already has a folder. Use Merge to combine them.`)
          await this.relocate(folder, target, folder.parentId!, folder.rootId)
        }
        this.carryCharacterName(before, clean)
      }
      this.reviews.saveName(raw, clean, series.trim())
      this.emit({ type: 'changed' })
      this.emit({ type: 'reviews' })
    })
  }

  /** Moves the images directly in one character's folder into another's, and makes the first name point at the second. */
  mergeCharacters(fromRaw: string, intoRaw: string): Promise<{ moved: number; failed: number }> {
    return this.serialize(async () => {
      const names = this.reviews.getNames()
      const from = displayName(fromRaw, names)
      const into = displayName(intoRaw, names)
      if (nameKey(from) === nameKey(into)) throw new Error('Choose a different character to merge into.')
      const source = this.characterFolder(from)
      const destination = path.join(this.library.getSettings().charactersRoot, folderName(into, 'Character'))
      const { moved, failed } = source ? await this.moveFolderImages(source, destination) : { moved: 0, failed: 0 }
      this.carryCharacterName(from, into)
      const series = seriesLabel(intoRaw, names)
      this.reviews.saveName(fromRaw, into, series)
      this.emit({ type: 'changed' })
      this.emit({ type: 'reviews' })
      return { moved, failed }
    })
  }

  /** Moves the images directly in one folder into another, then removes the first if nothing's left in it. */
  private async moveFolderImages(source: FolderInfo, destination: string): Promise<{ moved: number; failed: number }> {
    if (!this.rootContaining(destination)) throw new Error('That folder must be inside a watched folder. Check Settings.')
    const { items } = this.library.listImages({ folderId: source.id, search: '', sort: 'name', includeSubfolders: false, offset: 0, limit: Number.MAX_SAFE_INTEGER })
    const target = { kind: 'set' as const, label: '', directory: destination, action: 'move' as const }
    let moved = 0
    let failed = 0
    for (const item of items) {
      const file = this.library.imageFile(item.id)
      try {
        if (!file) throw new Error('missing')
        await placeFile(file.path, item.name, [target])
        moved++
      } catch {
        failed++
      }
    }
    if (!failed) await fsp.rmdir(source.path).catch(() => undefined)
    await this.syncFolders([source.path], [destination])
    const parent = this.library.getFolder(source.parentId!)
    if (parent) await this.queueScan(source.rootId, [{ path: parent.path, recursive: true }])
    return { moved, failed }
  }

  // Sets

  private setFolder(name: string): FolderInfo | null {
    return this.library.getFolderByPath(path.join(this.library.getSettings().setsRoot, folderName(name, 'Set')))
  }

  getSets(): SetEntry[] {
    const settings = this.library.getSettings()
    const root = this.library.getFolderByPath(settings.setsRoot)
    const linkFor = new Map(this.discord.getLinks().filter((l) => l.kind === 'sets').map((l) => [nameKey(l.name), l.threadId]))
    const entries = new Map<string, SetEntry>()
    for (const folder of root ? this.library.getChildren(root.id) : []) {
      entries.set(nameKey(folder.name), { key: nameKey(folder.name), name: folder.name, folderId: folder.id, imageCount: folder.totalCount, threadId: linkFor.get(nameKey(folder.name)) ?? null })
    }
    for (const link of this.discord.getLinks().filter((l) => l.kind === 'sets')) {
      if (!entries.has(nameKey(link.name))) entries.set(nameKey(link.name), { key: nameKey(link.name), name: link.name, folderId: null, imageCount: 0, threadId: link.threadId })
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  renameSet(name: string, newName: string): Promise<void> {
    return this.exclusive(async () => {
      const clean = newName.trim()
      assertSafeFolderName(clean)
      const folder = this.setFolder(name)
      if (folder) {
        const target = path.join(this.library.getSettings().setsRoot, clean)
        if (nameKey(name) !== nameKey(clean) && existsSync(target)) throw new Error(`${clean} already exists. Use Merge to combine them.`)
        await this.relocate(folder, target, folder.parentId!, folder.rootId)
      }
      this.carrySetName(name, clean)
      this.emit({ type: 'changed' })
      this.emit({ type: 'reviews' })
    })
  }

  mergeSets(from: string, into: string): Promise<{ moved: number; failed: number }> {
    return this.serialize(async () => {
      if (nameKey(from) === nameKey(into)) throw new Error('Choose a different set to merge into.')
      const source = this.setFolder(from)
      const destination = path.join(this.library.getSettings().setsRoot, folderName(into, 'Set'))
      const result = source ? await this.moveFolderImages(source, destination) : { moved: 0, failed: 0 }
      this.carrySetName(from, into)
      this.emit({ type: 'changed' })
      this.emit({ type: 'reviews' })
      return result
    })
  }

  // Auto-approve history

  getAutoApprovals(): AutoApproval[] {
    const rows = this.library.db
      .prepare(
        `SELECT a.id, a.image_id, a.character, a.approved_at, i.name, i.mtime_ms
         FROM auto_approvals a JOIN images i ON i.id = a.image_id
         WHERE i.missing = 0 ORDER BY a.approved_at DESC, a.id DESC LIMIT ${AUTO_APPROVALS_KEPT}`
      )
      .all() as Array<{ id: number; image_id: number; character: string; approved_at: number; name: string; mtime_ms: number }>
    return rows.map((row) => ({ id: row.id, imageId: row.image_id, name: row.name, character: row.character, mtimeMs: row.mtime_ms, approvedAt: row.approved_at }))
  }

  private autoApprovalCount(): number {
    const { n } = this.library.db
      .prepare('SELECT COUNT(*) AS n FROM auto_approvals a JOIN images i ON i.id = a.image_id WHERE i.missing = 0')
      .get() as { n: number }
    return n
  }

  /** Puts images back where they were and returns them to the review queue, one at a time. */
  undoAutoApprovals(ids: number[] | null): Promise<{ undone: number; failed: string[] }> {
    return this.serialize(async () => {
      const db = this.library.db
      const rows = (db.prepare('SELECT id, undo FROM auto_approvals ORDER BY id DESC').all() as Array<{ id: number; undo: string }>).filter((row) => !ids || ids.includes(row.id))
      let undone = 0
      const failed: string[] = []
      for (const row of rows) {
        const problems = await this.undoEntry(JSON.parse(row.undo) as UndoEntry)
        if (problems.length) failed.push(...problems)
        else {
          db.prepare('DELETE FROM auto_approvals WHERE id = ?').run(row.id)
          undone++
        }
      }
      this.emit({ type: 'reviews' })
      return { undone, failed }
    })
  }

  /** Forgets the history. The images stay where they are. */
  clearAutoApprovals(): void {
    this.library.db.exec('DELETE FROM auto_approvals')
    this.emit({ type: 'reviews' })
  }

  // Corrections

  getCorrections(): Correction[] {
    return this.reviews.getCorrections()
  }

  forgetCorrection(suggested: string, chosen: string): void {
    this.reviews.forgetCorrection(suggested, chosen)
  }

  getAppInfo(version: string): AppInfo {
    const folder = path.join(this.config.dataDir, 'backups')
    return { version, dataFolder: this.config.dataDir, backups: existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.db')).length : 0 }
  }

  // Duplicates

  /** Fingerprints images in the background. Results are saved, so later runs only cover what changed. */
  startDuplicateScan(folderId: number | null): void {
    if (this.duplicates.phase === 'running') throw new Error('A duplicate check is already running.')
    const ids = folderId === null ? this.library.allImageIds() : this.library.imageIdsInFolder(folderId)
    this.duplicatesCancelled = false
    this.duplicates = { phase: 'running', done: 0, total: ids.length, failed: 0 }
    this.emit({ type: 'duplicates', status: this.duplicates })
    this.duplicatesFinished = this.runDuplicateScan(ids)
  }

  duplicatesFinished: Promise<void> = Promise.resolve()

  cancelDuplicateScan(): void {
    this.duplicatesCancelled = true
  }

  private async runDuplicateScan(ids: number[]): Promise<void> {
    let done = 0
    let failed = 0
    let last = 0
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < ids.length && !this.duplicatesCancelled) {
        const id = ids[next++]!
        const file = this.library.imageFile(id)
        try {
          if (file) await savedFingerprint(this.library, id, file.path)
        } catch {
          failed++
        }
        done++
        if (Date.now() - last > 200) {
          last = Date.now()
          this.duplicates = { phase: 'running', done, total: ids.length, failed }
          this.emit({ type: 'duplicates', status: this.duplicates })
        }
      }
    }
    await Promise.all(Array.from({ length: DUPLICATE_WORKERS }, () => worker()))
    this.duplicates = { phase: this.duplicatesCancelled ? 'cancelled' : 'complete', done, total: ids.length, failed }
    this.emit({ type: 'duplicates', status: this.duplicates })
  }

  /**
   * Finds images with identical pixels. Copies made on purpose are left out: the same image once per
   * folder across the Characters and Sets folders is how sorting is meant to work.
   */
  getDuplicates(folderId: number | null): DuplicateGroup[] {
    const settings = this.library.getSettings()
    const ids = new Set(folderId === null ? [] : this.library.imageIdsInFolder(folderId))
    const rows = this.library.db
      .prepare(
        `SELECT i.id, i.name, i.size, i.mtime_ms, i.pixel_hash, f.path AS folder
         FROM images i JOIN folders f ON f.id = i.folder_id
         WHERE i.missing = 0 AND i.pixel_hash IS NOT NULL ORDER BY f.path_key, i.sort_key`
      )
      .all() as Array<{ id: number; name: string; size: number; mtime_ms: number; pixel_hash: string; folder: string }>
    const groups = new Map<string, typeof rows>()
    for (const row of rows) {
      if (folderId !== null && !ids.has(row.id)) continue
      groups.set(row.pixel_hash, [...(groups.get(row.pixel_hash) ?? []), row])
    }
    const inside = (folder: string, root: string): boolean => pathKey(folder).startsWith(`${pathKey(root)}\\`)
    const result: DuplicateGroup[] = []
    for (const [fingerprint, images] of groups) {
      if (images.length < 2) continue
      const sorted = images.every((image) => inside(image.folder, settings.charactersRoot) || inside(image.folder, settings.setsRoot))
      const separate = new Set(images.map((image) => pathKey(image.folder))).size === images.length
      if (sorted && separate) continue
      const [hash, width, height] = fingerprint.split('|')
      result.push({
        hash: hash!,
        width: Number(width),
        height: Number(height),
        images: images.map((image) => ({ id: image.id, name: image.name, folder: image.folder, size: image.size, mtimeMs: image.mtime_ms }))
      })
    }
    return result
  }

  // Catalogues

  private catalogueChanged<T>(value: T): T {
    this.emit({ type: 'catalogues' })
    return value
  }

  getCatalogues(): CatalogueInfo[] {
    return this.catalogues.list()
  }

  createCatalogue(name: string, description: string): CatalogueInfo {
    return this.catalogueChanged(this.catalogues.create(name, description))
  }

  updateCatalogue(id: number, name: string, description: string): void {
    this.catalogues.update(id, name, description)
    this.emit({ type: 'catalogues' })
  }

  deleteCatalogue(id: number): void {
    this.catalogues.delete(id)
    this.emit({ type: 'catalogues' })
  }

  addToCatalogue(id: number, imageIds: number[]): number {
    return this.catalogueChanged(this.catalogues.add(id, imageIds))
  }

  addFolderToCatalogue(id: number, folderId: number): number {
    return this.catalogueChanged(this.catalogues.add(id, this.library.imageIdsInFolder(folderId)))
  }

  moveInCatalogue(id: number, imageId: number, beforeImageId: number | null): void {
    this.catalogues.move(id, imageId, beforeImageId)
    this.emit({ type: 'catalogues' })
  }

  setCatalogueCover(id: number, imageId: number | null): void {
    this.catalogues.setCover(id, imageId)
    this.emit({ type: 'catalogues' })
  }

  removeFromCatalogue(id: number, imageIds: number[]): void {
    this.catalogues.remove(id, imageIds)
    this.emit({ type: 'catalogues' })
  }

  listCatalogueImages(id: number, offset: number, limit: number): ImagePage {
    return this.catalogues.images(id, offset, limit)
  }

  /** Starts the export in the background. Progress and any failure arrive as events. */
  startCatalogueExport(id: number, parent: string): void {
    if (this.exporting) throw new Error('An export is already running.')
    this.exporting = true
    this.exportFinished = exportCatalogue(this.library, this.catalogues, id, parent, (status) => this.emit({ type: 'export', status }))
      .catch((error: Error) => this.emit({ type: 'export', status: { phase: 'error', done: 0, total: 0, folder: '', skipped: 0, error: error.message } }))
      .finally(() => {
        this.exporting = false
      })
  }

  exportFinished: Promise<void> = Promise.resolve()

  // Review

  getReviewState(): ReviewState {
    const settings = this.library.getSettings()
    const sets = this.reviews.childFolderNames(settings.setsRoot)
    const sources = this.reviews.setSources()
    return {
      items: this.reviews.list().map((item) => ({ ...item, suggestedSet: suggestSet(item.folder, item.name, sets, sources) })),
      names: this.reviews.getNames(),
      knownCharacters: this.reviews.knownCharacters(settings.charactersRoot),
      sets,
      usedNames: this.reviews.usedNames(),
      discordQueued: this.reviews.discordCount(),
      autoApproved: this.autoApprovalCount()
    }
  }

  /** Starts recognition for a folder. Returns how many images will be scanned. */
  startRecognition(request: ScanRequest): number {
    const images = this.reviews.eligible(request.folderId, request.includeSubfolders, request.force, this.library.getSettings().queueLimit)
    if (images.length) this.recognition.start(images)
    return images.length
  }

  private rootContaining(file: string): RootInfo | null {
    const key = pathKey(file)
    if (this.library.isUntracked(file)) return null
    return this.library.getRoots().find((root) => root.available && (key === pathKey(root.path) || key.startsWith(`${pathKey(root.path)}\\`))) ?? null
  }

  /** Rescans changed folders, starting with where files left, so that moves are recognized as moves. */
  private async syncFolders(sources: string[], destinations: string[]): Promise<void> {
    const seen = new Set<string>()
    const groups = new Map<number, ScanTarget[]>()
    for (const dir of [...sources, ...destinations]) {
      const key = pathKey(dir)
      const root = this.rootContaining(dir)
      if (seen.has(key) || !root) continue
      seen.add(key)
      groups.set(root.id, [...(groups.get(root.id) ?? []), { path: dir, recursive: false }])
    }
    for (const [rootId, targets] of groups) await this.queueScan(rootId, targets)
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operations.then(work)
    this.operations = next.catch(() => undefined)
    return next
  }

  private remember(entry: UndoEntry): number {
    const token = this.nextUndo++
    this.undoEntries.set(token, entry)
    if (this.undoEntries.size > UNDO_DEPTH) this.undoEntries.delete(this.undoEntries.keys().next().value!)
    return token
  }

  applyReviews(requests: ApplyRequest[]): Promise<ApplyOutcome> {
    return this.serialize(async () => {
      const { results, undo } = await this.placeReviews(requests, true)
      return { results, undoToken: undo.length ? this.remember(combineUndo(undo)) : null }
    })
  }

  private async placeReviews(requests: ApplyRequest[], learn: boolean): Promise<{ results: ApplyResult[]; undo: Array<{ request: ApplyRequest; entry: UndoEntry }> }> {
    {
      const settings = this.library.getSettings()
      const names = this.reviews.getNames()
      const results: ApplyResult[] = []
      const placed: Array<{ request: ApplyRequest; journal: PlacementJournal; row: ReviewSnapshot | undefined }> = []

      for (const request of requests) {
        try {
          const file = this.library.imageFile(request.id)
          if (!file) throw new Error('This image is no longer available.')
          const stat = await fsp.stat(file.path, { bigint: true })
          if (Math.trunc(Number(stat.mtimeMs)) !== file.mtimeMs) throw new Error('This image changed since it was scanned. Scan it again.')
          const targets = planPlacement({
            characters: request.characters.map((raw) => displayName(raw, names)),
            setName: request.setName,
            placeInCharacters: request.placeInCharacters,
            placeInSet: request.placeInSet,
            roots: { characters: settings.charactersRoot, sets: settings.setsRoot }
          })
          for (const target of targets) {
            if (!this.rootContaining(target.directory)) {
              const kind = target.kind === 'character' ? 'Characters' : 'Sets'
              throw new Error(`The ${kind} folder must be inside a watched folder. Check Settings.`)
            }
          }
          const row = this.reviews.snapshot([request.id])[0]
          const journal = await placeFile(file.path, request.name, targets)
          placed.push({ request, journal, row })
          results.push({ id: request.id, ok: true, name: path.basename(journal.to) })
        } catch (error) {
          results.push({ id: request.id, ok: false, error: (error as Error).message })
        }
      }

      await this.syncFolders(
        placed.map(({ journal }) => path.dirname(journal.from)),
        placed.flatMap(({ journal }) => [path.dirname(journal.to), ...journal.copies.map((copy) => path.dirname(copy))])
      )

      const undo: Array<{ request: ApplyRequest; entry: UndoEntry }> = []
      this.library.transaction(() => {
        for (const { request, journal, row } of placed) {
          // Rescanning normally keeps the id. A move between drives creates a new one.
          const id = this.library.imageIdAtPath(journal.to) ?? request.id
          this.reviews.dismiss(id === request.id ? [id] : [request.id, id], 'processed')
          if (request.queueForDiscord) this.reviews.enqueueDiscord(id, request.characters, request.setName)
          if (learn && row && settings.learnCorrections) this.reviews.learnFromChoice(JSON.parse(row.candidates) as Candidate[], request.characters)
          if (request.setName) this.reviews.recordSetSource(path.dirname(journal.from), request.setName)
          // Characters and sets become tags, so they can be searched wherever the file ends up.
          const tags = [...request.characters.map((raw) => displayName(raw, names)), ...(request.setName ? [request.setName] : [])]
          const already = new Set(this.library.getImageTags(id).map((tag) => tag.toLowerCase()))
          this.library.addImageTags([id], tags)
          undo.push({
            request,
            entry: { journals: [journal], rows: row ? [row] : [], queued: [id], tags: [{ id, tags: tags.filter((tag) => !already.has(tag.toLowerCase())) }] }
          })
          for (const copy of journal.copies) {
            const copyId = this.library.imageIdAtPath(copy)
            if (copyId) {
              this.reviews.setState(copyId, 'processed')
              this.library.addImageTags([copyId], tags)
            }
          }
        }
      })
      this.emit({ type: 'reviews' })
      return { results, undo }
    }
  }

  private dismissWithUndo(ids: number[], status: 'processed' | 'cleared'): number {
    const rows = this.reviews.snapshot(ids)
    this.reviews.dismiss(ids, status)
    this.emit({ type: 'reviews' })
    return this.remember({ journals: [], rows, queued: [], tags: [] })
  }

  skipReviews(ids: number[]): number {
    return this.dismissWithUndo(ids, 'processed')
  }

  /** Clears suggestions only. Files, filenames, and folders stay as they are. */
  clearReviews(): number {
    return this.dismissWithUndo(this.reviews.allIds(), 'cleared')
  }

  /** After images go to the Recycle Bin, drops them from the queue and updates the index. */
  async afterTrash(ids: number[], paths: string[]): Promise<void> {
    this.reviews.dismiss(ids, 'processed')
    await this.syncFolders(paths.map((file) => path.dirname(file)), [])
    this.emit({ type: 'reviews' })
  }

  undo(token: number): Promise<void> {
    return this.serialize(async () => {
      const entry = this.undoEntries.get(token)
      if (!entry) throw new Error('This can no longer be undone.')
      this.undoEntries.delete(token)
      const failures = await this.undoEntry(entry)
      if (failures.length) throw new Error(failures[0]!)
    })
  }

  private async undoEntry(entry: UndoEntry): Promise<string[]> {
    {
      // Checked and reversed newest first, so a problem partway leaves earlier images applied, not broken.
      const failures: string[] = []
      const undone: PlacementJournal[] = []
      for (const journal of [...entry.journals].reverse()) {
        try {
          await undoPlacement(journal)
          undone.push(journal)
        } catch (error) {
          failures.push((error as Error).message)
        }
      }
      await this.syncFolders(
        undone.flatMap((journal) => [path.dirname(journal.to), ...journal.copies.map((copy) => path.dirname(copy))]),
        undone.map((journal) => path.dirname(journal.from))
      )
      if (entry.journals.length) {
        const restored = new Set(undone.map((journal) => pathKey(journal.from)))
        const reachable = entry.rows.filter((row) => {
          const file = this.library.imageFile(row.id)
          return file && restored.has(pathKey(file.path))
        })
        // Images that made it back, including any applied without a review record.
        const back = new Set(
          entry.queued.filter((id) => {
            const file = this.library.imageFile(id)
            return file && restored.has(pathKey(file.path))
          })
        )
        this.reviews.dequeueDiscord([...back])
        this.reviews.restore(reachable)
        for (const { id, tags } of entry.tags ?? []) if (back.has(id)) this.library.removeImageTags(id, tags)
      } else {
        this.reviews.restore(entry.rows)
      }
      this.emit({ type: 'reviews' })
      return failures
    }
  }

  saveDrafts(drafts: Array<{ id: number; draft: Draft }>): void {
    this.library.transaction(() => {
      for (const { id, draft } of drafts) this.reviews.saveDraft(id, draft)
    })
  }

  saveCharacterName(raw: string, name: string, series: string | null): void {
    this.reviews.saveName(raw, name, series)
    this.emit({ type: 'reviews' })
  }

  /**
   * Applies an image with one confident character match and nothing else suggested. The image goes
   * to its character folder, the same as if it had been reviewed by hand.
   */
  private async autoApprove(results: Map<number, Array<{ tag: string; score: number; filenameOnly?: boolean }>>): Promise<number> {
    const settings = this.library.getSettings()
    if (!settings.autoApprove || !this.rootContaining(settings.charactersRoot)) return 0
    const names = this.reviews.getNames()
    const used = new Set(this.reviews.usedNames())
    const requests: ApplyRequest[] = []
    for (const [id, candidates] of results) {
      const only = candidates.length === 1 ? candidates[0] : undefined
      const file = this.library.imageFile(id)
      if (!only || only.filenameOnly || only.score < settings.autoApproveThreshold || !file) continue
      // A learned correction still gets a human look, since the model didn't see that character.
      if (settings.learnCorrections && this.reviews.applyCorrections([only])[0]?.learnedFrom) continue
      const name = imageName(namingBase([only.tag], names), extensionOf(path.basename(file.path)), used)
      used.add(name.toLowerCase())
      requests.push({ id, name, characters: [only.tag], setName: null, placeInCharacters: true, placeInSet: false })
    }
    if (!requests.length) return 0
    const { results: outcomes, undo } = await this.serialize(() => this.placeReviews(requests, false))
    // Kept on disk, so that a wrong match can be put back even after restarting.
    const insert = this.library.db.prepare('INSERT INTO auto_approvals (image_id, character, undo, approved_at) VALUES (?, ?, ?, ?)')
    this.library.transaction(() => {
      for (const { request, entry } of undo) insert.run(entry.queued[0]!, displayName(request.characters[0]!, names), JSON.stringify(entry), Date.now())
      this.library.db.prepare(`DELETE FROM auto_approvals WHERE id NOT IN (SELECT id FROM auto_approvals ORDER BY id DESC LIMIT ${AUTO_APPROVALS_KEPT})`).run()
    })
    this.emit({ type: 'reviews' })
    return outcomes.filter((outcome) => outcome.ok).length
  }
}
