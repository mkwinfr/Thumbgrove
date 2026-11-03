import type { CharacterName } from './naming'

export type ImageSort = 'name' | 'newest' | 'oldest' | 'largest'

export interface RootInfo {
  id: number
  folderId: number
  name: string
  path: string
  available: boolean
  imageCount: number
  lastScanAt: number | null
}

export interface FolderInfo {
  id: number
  rootId: number
  parentId: number | null
  name: string
  path: string
  imageCount: number
  totalCount: number
  coverId: number | null
  coverVersion: number
  hasChildren: boolean
  available: boolean
  favorite: boolean
}

export interface UntrackedFolder {
  rootId: number
  path: string
}

export interface ImageInfo {
  id: number
  folderId: number
  name: string
  size: number
  mtimeMs: number
}

export interface ImageQuery {
  /** Null searches every watched folder. */
  folderId: number | null
  search: string
  sort: ImageSort
  includeSubfolders: boolean
  offset: number
  limit: number
}

export interface ImagePage {
  total: number
  items: ImageInfo[]
}

export interface ScanStatus {
  active: boolean
  rootName: string
  filesSeen: number
}

export interface Settings {
  queueLimit: number
  autoApprove: boolean
  /** Lowest confidence, from 0 to 1, that auto-approve accepts. */
  autoApproveThreshold: number
  /** Lowest confidence, from 0 to 1, that gets a suggestion ticked in advance. */
  preselectThreshold: number
  charactersRoot: string
  setsRoot: string
  autoScanEnabled: boolean
  /** The one folder scanned automatically when new images arrive. */
  autoScanFolder: string
  autoScanSubfolders: boolean
  defaultPlaceInCharacters: boolean
  defaultPlaceInSet: boolean
  /** Starts the next image with the set just applied. */
  carrySet: boolean
  /** Smallest width of a grid tile, in pixels. */
  tileSize: number
  /** Largest upload in MB. Zero follows the server's boost level. */
  uploadLimitMb: number
  checkBeforeUpload: boolean
  /** Replaces a suggestion with the character you keep choosing instead. */
  learnCorrections: boolean
}

export interface AutoApproval {
  id: number
  imageId: number
  name: string
  character: string
  mtimeMs: number
  approvedAt: number
}

export interface Correction {
  suggested: string
  chosen: string
  times: number
}

export interface SetEntry {
  key: string
  name: string
  folderId: number | null
  imageCount: number
  threadId: string | null
}

export interface AppInfo {
  version: string
  dataFolder: string
  backups: number
}

export type SettingsChange = Partial<Omit<Settings, 'charactersRoot' | 'setsRoot'>>

export interface CharacterEntry {
  key: string
  raw: string
  name: string
  series: string
  folderId: number | null
  imageCount: number
  threadId: string | null
}

export interface DuplicateGroup {
  hash: string
  width: number
  height: number
  images: Array<{ id: number; name: string; folder: string; size: number; mtimeMs: number }>
}

export interface DuplicateStatus {
  phase: 'idle' | 'running' | 'complete' | 'cancelled'
  done: number
  total: number
  failed: number
}

export interface CatalogueInfo {
  id: number
  name: string
  description: string
  imageCount: number
  coverId: number | null
  coverVersion: number
}

export interface ExportStatus {
  phase: 'idle' | 'running' | 'complete' | 'error'
  done: number
  total: number
  folder: string
  skipped: number
  error: string | null
}

export interface Candidate {
  tag: string
  score: number
  /** Matched from the filename only, not from the image. */
  filenameOnly?: boolean
  filenameMatch?: boolean
  /** The model's guess, replaced by the character you've chosen instead in the past. */
  learnedFrom?: string
}

export interface Draft {
  /** Character tags and typed names, in the order they were chosen. */
  characters: string[]
  setName: string | null
  /** Filename typed by the user. Null means it is generated. */
  customName: string | null
  placeInCharacters: boolean
  placeInSet: boolean
}

export interface ReviewRecord {
  id: number
  name: string
  folder: string
  size: number
  mtimeMs: number
  candidates: Candidate[]
  error: string | null
  draft: Draft | null
  /** A set this image probably belongs to. It's never chosen for you. */
  suggestedSet: string | null
}

export interface ReviewState {
  items: ReviewRecord[]
  names: CharacterName[]
  knownCharacters: string[]
  sets: string[]
  /** Lowercase filenames already in use, so generated names don't collide. */
  usedNames: string[]
  discordQueued: number
  autoApproved: number
}

export interface ApplyRequest {
  id: number
  name: string
  characters: string[]
  setName: string | null
  placeInCharacters: boolean
  placeInSet: boolean
  /** Also adds the image to the Discord queue. Applying alone only sorts the file. */
  queueForDiscord?: boolean
}

export interface ApplyResult {
  id: number
  ok: boolean
  name?: string
  error?: string
}

export interface ApplyOutcome {
  results: ApplyResult[]
  undoToken: number | null
}

export interface ScanRequest {
  folderId: number
  includeSubfolders: boolean
  force: boolean
}

export interface RecognitionStatus {
  phase: 'idle' | 'downloading' | 'loading' | 'running' | 'cancelling' | 'complete' | 'cancelled' | 'error'
  done: number
  total: number
  name: string
  provider: string
  error: string | null
  autoApproved: number
  modelReady: boolean
  modelSize: number
}

export type ThreadKind = 'characters' | 'sets'

export interface DiscordConfig {
  guildId: string
  parents: { characters: string; sets: string }
}

export interface DiscordStatus {
  hasToken: boolean
  connected: boolean
  username: string
  error: string | null
  config: DiscordConfig
  uploadLimitBytes: number
}

export interface DiscordLink {
  kind: ThreadKind
  name: string
  threadId: string
  threadName: string | null
}

export interface ChannelOption {
  id: string
  name: string
  type: number
}

export interface ThreadOption {
  id: string
  name: string
}

export interface ThreadSetup {
  channelId: string
  isForum: boolean
  requiresTag: boolean
  tags: Array<{ id: string; name: string }>
}

export interface QueueEntry {
  id: number
  name: string
  mtimeMs: number
  size: number
  /** Larger than this server accepts. */
  tooLarge: boolean
  targets: Array<{ kind: ThreadKind; name: string; threadId: string; threadName: string | null; posted: boolean }>
  missing: Array<{ kind: ThreadKind; name: string }>
  lastError: string | null
}

export interface RemovedFromQueue {
  imageId: number
  characters: string
  setName: string | null
  queuedAt: number
}

export interface UpdateStatus {
  /** `unavailable` means this copy doesn't update itself, like the portable version. */
  phase: 'unavailable' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error'
  /** The version being downloaded or ready to install. */
  version: string | null
  percent: number
  error: string | null
}

export interface UploadStatus {
  phase: 'idle' | 'checking' | 'running' | 'cancelling' | 'complete' | 'cancelled'
  /** Whether this job posts images, or only compares the queue with Discord. */
  mode: 'upload' | 'check'
  done: number
  total: number
  name: string
  posted: number
  /** Images skipped because they were already in the thread. */
  duplicates: number
  failed: number
  /** Something the check couldn't do, like reading a thread. */
  warning: string | null
}

export interface HistoryEntry {
  id: number
  name: string
  targetName: string
  threadId: string
  messageId: string
  postedAt: number
  imageId: number | null
  imageVersion: number | null
}

export interface DiscordSaveRequest {
  /** Left empty to keep the saved token. */
  token: string
  config: DiscordConfig
}

export type LibraryEvent =
  | { type: 'changed' }
  | { type: 'scan'; status: ScanStatus }
  | { type: 'reviews' }
  | { type: 'recognition'; status: RecognitionStatus }
  | { type: 'discord' }
  | { type: 'upload'; status: UploadStatus }
  | { type: 'duplicates'; status: DuplicateStatus }
  | { type: 'catalogues' }
  | { type: 'export'; status: ExportStatus }
  | { type: 'settings'; settings: Settings }

/** What the interface can ask the desktop app to do. */
export interface ThumbGroveApi {
  getSettings(): Promise<Settings>
  updateSettings(change: SettingsChange): Promise<Settings>
  searchFolders(query: string): Promise<FolderInfo[]>
  getCharacters(): Promise<CharacterEntry[]>
  /** Renaming also renames the character's folder and Discord thread link. */
  updateCharacter(raw: string, name: string, series: string): Promise<void>
  /** Moves one character's images into another's folder, and combines their names. */
  mergeCharacters(fromRaw: string, intoRaw: string): Promise<{ moved: number; failed: number }>
  getSets(): Promise<SetEntry[]>
  renameSet(name: string, newName: string): Promise<void>
  mergeSets(from: string, into: string): Promise<{ moved: number; failed: number }>
  getAutoApprovals(): Promise<AutoApproval[]>
  /** Puts auto-approved images back. Leaving out ids undoes all of them. */
  undoAutoApprovals(ids: number[] | null): Promise<{ undone: number; failed: string[] }>
  clearAutoApprovals(): Promise<void>
  getCorrections(): Promise<Correction[]>
  forgetCorrection(suggested: string, chosen: string): Promise<void>
  getAppInfo(): Promise<AppInfo>
  openDataFolder(): Promise<void>
  openLogFolder(): Promise<void>
  startDuplicateScan(folderId: number | null): Promise<void>
  cancelDuplicateScan(): Promise<void>
  getDuplicates(folderId: number | null): Promise<DuplicateGroup[]>
  getCatalogues(): Promise<CatalogueInfo[]>
  createCatalogue(name: string, description: string): Promise<CatalogueInfo>
  updateCatalogue(id: number, name: string, description: string): Promise<void>
  deleteCatalogue(id: number): Promise<void>
  addToCatalogue(id: number, imageIds: number[]): Promise<number>
  addFolderToCatalogue(id: number, folderId: number): Promise<number>
  removeFromCatalogue(id: number, imageIds: number[]): Promise<void>
  /** Null puts the image last. */
  moveInCatalogue(id: number, imageId: number, beforeImageId: number | null): Promise<void>
  setCatalogueCover(id: number, imageId: number | null): Promise<void>
  listCatalogueImages(id: number, offset: number, limit: number): Promise<ImagePage>
  /** Asks where to save, then exports in the background. Returns false if the user cancels. */
  exportCatalogue(id: number): Promise<boolean>
  showExportedGallery(folder: string): Promise<void>
  chooseDestination(kind: 'characters' | 'sets'): Promise<Settings>
  getRoots(): Promise<RootInfo[]>
  addRoot(): Promise<RootInfo | null>
  addRootPath(path: string): Promise<RootInfo>
  removeRoot(id: number): Promise<void>
  rescan(): Promise<void>
  getChildren(parentId: number | null): Promise<FolderInfo[]>
  getFolder(id: number): Promise<FolderInfo | null>
  getFolderByPath(path: string): Promise<FolderInfo | null>
  getAncestors(id: number): Promise<FolderInfo[]>
  renameFolder(id: number, name: string): Promise<void>
  moveFolder(id: number, destination: string): Promise<void>
  untrackFolder(id: number): Promise<void>
  retrackFolder(folder: string): Promise<void>
  getUntracked(): Promise<UntrackedFolder[]>
  /** Sends a folder to the Windows Recycle Bin. */
  deleteFolder(id: number): Promise<void>
  listImages(query: ImageQuery): Promise<ImagePage>
  revealImage(id: number): Promise<void>
  copyImagePath(id: number): Promise<void>
  /** Queues images for Discord using the character or set folder they're in. */
  enqueueForDiscord(ids: number[]): Promise<{ queued: number; unknown: number }>
  enqueueFolderForDiscord(folderId: number): Promise<{ queued: number; unknown: number }>
  renameImages(requests: Array<{ id: number; name: string }>): Promise<ApplyOutcome>
  renameImagesToBase(ids: number[], base: string): Promise<ApplyOutcome>
  moveImages(ids: number[], destination: string): Promise<ApplyOutcome>
  /** Sends images to the Windows Recycle Bin. */
  deleteImages(ids: number[]): Promise<number>
  getImageTags(id: number): Promise<string[]>
  getAllTags(): Promise<string[]>
  setImageTags(id: number, tags: string[]): Promise<void>
  addImageTags(ids: number[], tags: string[]): Promise<number>
  addFolderTags(id: number, tags: string[]): Promise<number>
  createFolder(parentId: number, name: string): Promise<FolderInfo>
  setFolderFavorite(id: number, on: boolean): Promise<void>
  getFavorites(): Promise<FolderInfo[]>
  getReviewState(): Promise<ReviewState>
  saveDrafts(drafts: Array<{ id: number; draft: Draft }>): Promise<void>
  applyReviews(requests: ApplyRequest[]): Promise<ApplyOutcome>
  skipReviews(ids: number[]): Promise<number>
  clearReviews(): Promise<number>
  /** Sends images to the Windows Recycle Bin. */
  deleteReviews(ids: number[]): Promise<number>
  undoReview(token: number): Promise<void>
  startRecognition(request: ScanRequest): Promise<number>
  cancelRecognition(): Promise<void>
  getRecognitionStatus(): Promise<RecognitionStatus>
  downloadModel(): Promise<void>
  getDiscordStatus(): Promise<DiscordStatus>
  saveDiscord(request: DiscordSaveRequest): Promise<DiscordStatus>
  forgetDiscordToken(): Promise<DiscordStatus>
  getDiscordChannels(): Promise<ChannelOption[]>
  getDiscordThreads(kind: ThreadKind): Promise<ThreadOption[]>
  getDiscordThreadSetup(kind: ThreadKind): Promise<ThreadSetup>
  createDiscordThread(kind: ThreadKind, name: string, tagIds: string[], photoId: number | null): Promise<DiscordLink>
  getDiscordLinks(): Promise<DiscordLink[]>
  linkDiscordThread(kind: ThreadKind, name: string, threadId: string, threadName: string | null): Promise<void>
  unlinkDiscordThread(kind: ThreadKind, name: string): Promise<void>
  getDiscordQueue(): Promise<QueueEntry[]>
  /** Returns what was removed, which restoreToDiscordQueue can put back. */
  removeFromDiscordQueue(ids: number[]): Promise<RemovedFromQueue[]>
  restoreToDiscordQueue(rows: RemovedFromQueue[]): Promise<void>
  /** Compares the queue with what's on Discord and removes images already there. Posts nothing. */
  startDiscordCheck(): Promise<void>
  /** With a thread, images post only there. Otherwise they post to every thread they are linked to. */
  startDiscordUpload(ids: number[], threadId?: string): Promise<void>
  cancelDiscordUpload(): Promise<void>
  getDiscordUploadStatus(): Promise<UploadStatus>
  getDiscordHistory(): Promise<HistoryEntry[]>
  deleteDiscordPost(id: number): Promise<void>
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<void>
  /** Closes the app and installs the downloaded update. */
  installUpdate(): Promise<void>
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  onLibraryEvent(listener: (event: LibraryEvent) => void): () => void
}

declare global {
  interface Window {
    thumbGrove: ThumbGroveApi
  }
}

export function thumbUrl(id: number, version: number): string {
  return `thumbgrove://thumb/${id}?v=${Math.trunc(version)}`
}

export function imageUrl(id: number, version: number): string {
  return `thumbgrove://image/${id}?v=${Math.trunc(version)}`
}
