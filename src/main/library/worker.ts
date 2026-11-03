import { parentPort, workerData } from 'node:worker_threads'
import type { ApplyRequest, DiscordConfig, Draft, ScanRequest, SettingsChange, ThreadKind } from '../../shared/api'
import { LibraryService, type ServiceConfig } from './service'

const port = parentPort!
const service = new LibraryService(workerData as ServiceConfig, (event) => port.postMessage({ event }))
const { library, discord } = service

const methods = {
  getSettings: () => library.getSettings(),
  updateSettings: (change: SettingsChange) => service.updateSettings(change),
  searchFolders: (query: string) => service.searchFolders(query),
  getCharacters: () => service.getCharacters(),
  updateCharacter: (raw: string, name: string, series: string) => service.updateCharacter(raw, name, series),
  mergeCharacters: (fromRaw: string, intoRaw: string) => service.mergeCharacters(fromRaw, intoRaw),
  getSets: () => service.getSets(),
  renameSet: (name: string, newName: string) => service.renameSet(name, newName),
  mergeSets: (from: string, into: string) => service.mergeSets(from, into),
  getAutoApprovals: () => service.getAutoApprovals(),
  undoAutoApprovals: (ids: number[] | null) => service.undoAutoApprovals(ids),
  clearAutoApprovals: () => service.clearAutoApprovals(),
  getCorrections: () => service.getCorrections(),
  forgetCorrection: (suggested: string, chosen: string) => service.forgetCorrection(suggested, chosen),
  getAppInfo: (version: string) => service.getAppInfo(version),
  moveInCatalogue: (id: number, imageId: number, beforeImageId: number | null) => service.moveInCatalogue(id, imageId, beforeImageId),
  setCatalogueCover: (id: number, imageId: number | null) => service.setCatalogueCover(id, imageId),
  startDuplicateScan: (folderId: number | null) => service.startDuplicateScan(folderId),
  cancelDuplicateScan: () => service.cancelDuplicateScan(),
  getDuplicates: (folderId: number | null) => service.getDuplicates(folderId),
  getCatalogues: () => service.getCatalogues(),
  createCatalogue: (name: string, description: string) => service.createCatalogue(name, description),
  updateCatalogue: (id: number, name: string, description: string) => service.updateCatalogue(id, name, description),
  deleteCatalogue: (id: number) => service.deleteCatalogue(id),
  addToCatalogue: (id: number, imageIds: number[]) => service.addToCatalogue(id, imageIds),
  addFolderToCatalogue: (id: number, folderId: number) => service.addFolderToCatalogue(id, folderId),
  removeFromCatalogue: (id: number, imageIds: number[]) => service.removeFromCatalogue(id, imageIds),
  listCatalogueImages: (id: number, offset: number, limit: number) => service.listCatalogueImages(id, offset, limit),
  startCatalogueExport: (id: number, parent: string) => service.startCatalogueExport(id, parent),
  setDestination: (kind: 'characters' | 'sets', folder: string) => {
    library.setSetting(kind === 'characters' ? 'charactersRoot' : 'setsRoot', folder)
    return library.getSettings()
  },
  getRoots: () => library.getRoots(),
  addRoot: (folder: string) => service.addRoot(folder),
  removeRoot: (id: number) => service.removeRoot(id),
  rescan: () => service.rescan(),
  getChildren: (parentId: number | null) => library.getChildren(parentId),
  getFolder: (id: number) => library.getFolder(id),
  getFolderByPath: (folder: string) => library.getFolderByPath(folder),
  getAncestors: (id: number) => library.getAncestors(id),
  listImages: (query: Parameters<typeof library.listImages>[0]) => library.listImages(query),
  imageFile: (id: number) => library.imageFile(id),
  thumbnail: (id: number) => service.thumbnail(id),
  createFolder: (parentId: number, name: string) => service.createFolder(parentId, name),
  setFolderFavorite: (id: number, on: boolean) => service.setFolderFavorite(id, on),
  getFavorites: () => library.getFavorites(),
  renameImages: (requests: Array<{ id: number; name: string }>) => service.renameImages(requests),
  renameImagesToBase: (ids: number[], base: string) => service.renameImagesToBase(ids, base),
  moveImages: (ids: number[], destination: string) => service.moveImages(ids, destination),
  afterImagesTrash: (ids: number[], paths: string[]) => service.afterImagesTrash(ids, paths),
  getImageTags: (id: number) => service.getImageTags(id),
  getAllTags: () => service.getAllTags(),
  setImageTags: (id: number, tags: string[]) => service.setImageTags(id, tags),
  addImageTags: (ids: number[], tags: string[]) => service.addImageTags(ids, tags),
  addFolderTags: (id: number, tags: string[]) => service.addFolderTags(id, tags),
  renameFolder: (id: number, name: string) => service.renameFolder(id, name),
  moveFolder: (id: number, destination: string) => service.moveFolder(id, destination),
  untrackFolder: (id: number) => service.untrackFolder(id),
  retrackFolder: (folder: string) => service.retrackFolder(folder),
  getUntracked: () => library.getUntracked(),
  prepareFolderDelete: (id: number) => service.prepareFolderDelete(id),
  afterFolderTrash: (id: number) => service.afterFolderTrash(id),
  getReviewState: () => service.getReviewState(),
  saveDrafts: (drafts: Array<{ id: number; draft: Draft }>) => service.saveDrafts(drafts),
  applyReviews: (requests: ApplyRequest[]) => service.applyReviews(requests),
  skipReviews: (ids: number[]) => service.skipReviews(ids),
  clearReviews: () => service.clearReviews(),
  afterTrash: (ids: number[], paths: string[]) => service.afterTrash(ids, paths),
  undoReview: (token: number) => service.undo(token),
  startRecognition: (request: ScanRequest) => service.startRecognition(request),
  cancelRecognition: () => service.recognition.cancel(),
  getRecognitionStatus: () => service.recognition.status(),
  downloadModel: () => service.recognition.download(),
  setDiscordToken: (token: string) => discord.setToken(token),
  getDiscordStatus: () => discord.getStatus(),
  saveDiscordConfig: (config: DiscordConfig) => discord.saveConfig(config),
  getDiscordChannels: () => discord.getChannels(),
  getDiscordThreads: (kind: ThreadKind) => discord.getThreads(kind),
  getDiscordThreadSetup: (kind: ThreadKind) => discord.getThreadSetup(kind),
  createDiscordThread: (kind: ThreadKind, name: string, tags: string[], photoId: number | null) => discord.createThread(kind, name, tags, photoId),
  getDiscordLinks: () => discord.getLinks(),
  linkDiscordThread: (kind: ThreadKind, name: string, threadId: string, threadName: string | null) => discord.linkThread(kind, name, threadId, threadName),
  unlinkDiscordThread: (kind: ThreadKind, name: string) => discord.unlinkThread(kind, name),
  getDiscordQueue: () => discord.getQueue(),
  removeFromDiscordQueue: (ids: number[]) => discord.removeFromQueue(ids),
  restoreToDiscordQueue: (rows: ReturnType<typeof discord.removeFromQueue>) => discord.restoreToQueue(rows),
  startDiscordCheck: () => discord.startCheck(),
  enqueueFromFolders: (ids: number[]) => discord.enqueueFromFolders(ids),
  startDiscordUpload: (ids: number[]) => discord.startUpload(ids),
  cancelDiscordUpload: () => discord.cancelUpload(),
  getDiscordUploadStatus: () => discord.getUploadStatus(),
  getDiscordHistory: () => discord.getHistory(),
  deleteDiscordPost: (id: number) => discord.deletePost(id)
}

export type WorkerMethods = typeof methods

port.on('message', async ({ id, method, args }: { id: number; method: keyof WorkerMethods; args: unknown[] }) => {
  try {
    const result = await (methods[method] as (...values: unknown[]) => unknown)(...args)
    port.postMessage({ id, result })
  } catch (error) {
    port.postMessage({ id, error: (error as Error).message })
  }
})

if (library.startupProblem) port.postMessage({ log: library.startupProblem })
service.start()
