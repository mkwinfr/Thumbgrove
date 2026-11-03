import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ApplyRequest, DiscordSaveRequest, Draft, ThumbGroveApi, ImageQuery, LibraryEvent, ScanRequest, SettingsChange, ThreadKind } from '../shared/api'
import { LibraryClient } from './library/client'
import { startLog, writeLog } from './log'
import { checkForUpdates, getUpdateStatus, installUpdate, startUpdater } from './updater'

// Lets checks run against a throwaway library instead of the real one.
if (process.env.THUMBGROVE_DATA_DIR) app.setPath('userData', process.env.THUMBGROVE_DATA_DIR)

protocol.registerSchemesAsPrivileged([{ scheme: 'thumbgrove', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

let window: BrowserWindow | null = null
let library: LibraryClient

function notFound(): Response {
  return new Response(null, { status: 404 })
}

/** Serves images by their index id, so the interface can never ask for an arbitrary file path. */
async function handleImageRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const id = Number(url.pathname.slice(1))
  if (!Number.isInteger(id)) return notFound()
  try {
    if (url.hostname === 'thumb') {
      const file = await library.call('thumbnail', id)
      if (!file) return notFound()
      const response = await net.fetch(pathToFileURL(file).toString())
      return new Response(response.body, {
        headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable' }
      })
    }
    if (url.hostname === 'image') {
      const file = await library.call('imageFile', id)
      return file ? await net.fetch(pathToFileURL(file.path).toString()) : notFound()
    }
  } catch {
    // Damaged or removed files appear as a placeholder tile.
  }
  return notFound()
}

function discordTokenFile(): string {
  return path.join(app.getPath('userData'), 'discord-token.bin')
}

/** The token is encrypted on disk. The interface never receives it, and only the worker holds it in memory. */
async function saveDiscordToken(token: string): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Windows secure storage is unavailable, so the token could not be saved.')
  await fs.writeFile(discordTokenFile(), await safeStorage.encryptStringAsync(token))
  await library.call('setDiscordToken', token)
}

async function loadDiscordToken(): Promise<void> {
  try {
    const encrypted = await fs.readFile(discordTokenFile())
    const { result } = await safeStorage.decryptStringAsync(encrypted)
    await library.call('setDiscordToken', result)
  } catch {
    // No saved token yet, or it can't be read. Discord settings will ask for one.
  }
}

async function pickFolder(title: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { title, properties: ['openDirectory'] }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function revealImage(id: number): Promise<void> {
  const file = await library.call('imageFile', id)
  if (file) shell.showItemInFolder(file.path)
}

/** Registers an action from the interface, recording failures in the log. Arguments are never logged. */
function handle(channel: string, action: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await action(event, ...args)
    } catch (error) {
      const message = (error as Error).message
      if (message !== 'MODEL_MISSING') writeLog('error', `${channel}: ${message}`)
      throw error
    }
  })
}

function registerHandlers(): void {
  handle('sets:list', () => library.call('getSets'))
  handle('sets:rename', (_e, name: string, newName: string) => library.call('renameSet', name, newName))
  handle('sets:merge', (_e, from: string, into: string) => library.call('mergeSets', from, into))
  handle('auto:list', () => library.call('getAutoApprovals'))
  handle('auto:undo', (_e, ids: number[] | null) => library.call('undoAutoApprovals', ids))
  handle('auto:clear', () => library.call('clearAutoApprovals'))
  handle('corrections:list', () => library.call('getCorrections'))
  handle('corrections:forget', (_e, suggested: string, chosen: string) => library.call('forgetCorrection', suggested, chosen))
  handle('app:info', () => library.call('getAppInfo', app.getVersion()))
  handle('updates:status', () => getUpdateStatus())
  handle('updates:check', () => checkForUpdates())
  handle('updates:install', () => installUpdate())
  handle('app:open-data', () => shell.openPath(app.getPath('userData')))
  handle('app:open-logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')))
  handle('catalogues:move', (_e, id: number, imageId: number, beforeImageId: number | null) => library.call('moveInCatalogue', id, imageId, beforeImageId))
  handle('catalogues:cover', (_e, id: number, imageId: number | null) => library.call('setCatalogueCover', id, imageId))
  handle('settings:get', () => library.call('getSettings'))
  handle('settings:update', (_e, change: SettingsChange) => library.call('updateSettings', change))
  handle('folders:search', (_e, query: string) => library.call('searchFolders', query))
  handle('characters:list', () => library.call('getCharacters'))
  handle('characters:update', (_e, raw: string, name: string, series: string) => library.call('updateCharacter', raw, name, series))
  handle('characters:merge', (_e, fromRaw: string, intoRaw: string) => library.call('mergeCharacters', fromRaw, intoRaw))
  handle('duplicates:start', (_e, folderId: number | null) => library.call('startDuplicateScan', folderId))
  handle('duplicates:cancel', () => library.call('cancelDuplicateScan'))
  handle('duplicates:list', (_e, folderId: number | null) => library.call('getDuplicates', folderId))
  handle('catalogues:list', () => library.call('getCatalogues'))
  handle('catalogues:create', (_e, name: string, description: string) => library.call('createCatalogue', name, description))
  handle('catalogues:update', (_e, id: number, name: string, description: string) => library.call('updateCatalogue', id, name, description))
  handle('catalogues:show', (_e, folder: string) => shell.showItemInFolder(path.join(folder, 'index.html')))
  handle('catalogues:delete', (_e, id: number) => library.call('deleteCatalogue', id))
  handle('catalogues:add', (_e, id: number, imageIds: number[]) => library.call('addToCatalogue', id, imageIds))
  handle('catalogues:add-folder', (_e, id: number, folderId: number) => library.call('addFolderToCatalogue', id, folderId))
  handle('catalogues:remove', (_e, id: number, imageIds: number[]) => library.call('removeFromCatalogue', id, imageIds))
  handle('catalogues:images', (_e, id: number, offset: number, limit: number) => library.call('listCatalogueImages', id, offset, limit))
  handle('catalogues:export', async (_e, id: number) => {
    const parent = await pickFolder('Choose where to save the gallery')
    if (!parent) return false
    await library.call('startCatalogueExport', id, parent)
    return true
  })
  handle('settings:destination', async (_e, kind: 'characters' | 'sets') => {
    const folder = await pickFolder(kind === 'characters' ? 'Choose the Characters folder' : 'Choose the Sets folder')
    return folder ? library.call('setDestination', kind, folder) : library.call('getSettings')
  })
  handle('roots:get', () => library.call('getRoots'))
  handle('roots:add', async () => {
    const folder = await pickFolder('Choose a folder to watch')
    return folder ? library.call('addRoot', folder) : null
  })
  handle('roots:add-path', (_e, folder: string) => library.call('addRoot', folder))
  handle('roots:remove', (_e, id: number) => library.call('removeRoot', id))
  handle('roots:rescan', () => library.call('rescan'))
  handle('folders:children', (_e, parentId: number | null) => library.call('getChildren', parentId))
  handle('folders:get', (_e, id: number) => library.call('getFolder', id))
  handle('folders:by-path', (_e, folder: string) => library.call('getFolderByPath', folder))
  handle('folders:ancestors', (_e, id: number) => library.call('getAncestors', id))
  handle('folders:rename', (_e, id: number, name: string) => library.call('renameFolder', id, name))
  handle('folders:move', (_e, id: number, destination: string) => library.call('moveFolder', id, destination))
  handle('folders:untrack', (_e, id: number) => library.call('untrackFolder', id))
  handle('folders:retrack', (_e, folder: string) => library.call('retrackFolder', folder))
  handle('folders:untracked', () => library.call('getUntracked'))
  handle('folders:delete', async (_e, id: number) => {
    const folder = await library.call('prepareFolderDelete', id)
    await shell.trashItem(folder)
    await library.call('afterFolderTrash', id)
  })
  handle('images:list', (_e, query: ImageQuery) => library.call('listImages', query))
  handle('images:reveal', (_e, id: number) => revealImage(id))
  handle('reviews:state', () => library.call('getReviewState'))
  handle('reviews:drafts', (_e, drafts: Array<{ id: number; draft: Draft }>) => library.call('saveDrafts', drafts))
  handle('reviews:apply', (_e, requests: ApplyRequest[]) => library.call('applyReviews', requests))
  handle('reviews:skip', (_e, ids: number[]) => library.call('skipReviews', ids))
  handle('reviews:clear', () => library.call('clearReviews'))
  handle('reviews:delete', async (_e, ids: number[]) => {
    const trashed: number[] = []
    const paths: string[] = []
    for (const id of ids) {
      const file = await library.call('imageFile', id)
      if (!file) continue
      await shell.trashItem(file.path)
      trashed.push(id)
      paths.push(file.path)
    }
    await library.call('afterTrash', trashed, paths)
    return trashed.length
  })
  handle('reviews:undo', (_e, token: number) => library.call('undoReview', token))
  handle('recognition:start', (_e, request: ScanRequest) => library.call('startRecognition', request))
  handle('recognition:cancel', () => library.call('cancelRecognition'))
  handle('recognition:status', () => library.call('getRecognitionStatus'))
  handle('recognition:download', () => library.call('downloadModel'))
  handle('discord:status', () => library.call('getDiscordStatus'))
  handle('discord:save', async (_e, request: DiscordSaveRequest) => {
    if (request.token.trim()) await saveDiscordToken(request.token.trim())
    await library.call('saveDiscordConfig', request.config)
    return library.call('getDiscordStatus')
  })
  handle('discord:forget-token', async () => {
    await fs.rm(discordTokenFile(), { force: true })
    await library.call('setDiscordToken', '')
    return library.call('getDiscordStatus')
  })
  handle('discord:channels', () => library.call('getDiscordChannels'))
  handle('discord:threads', (_e, kind: ThreadKind) => library.call('getDiscordThreads', kind))
  handle('discord:thread-setup', (_e, kind: ThreadKind) => library.call('getDiscordThreadSetup', kind))
  handle('discord:create-thread', (_e, kind: ThreadKind, name: string, tags: string[], photoId: number | null) =>
    library.call('createDiscordThread', kind, name, tags, photoId)
  )
  handle('discord:links', () => library.call('getDiscordLinks'))
  handle('discord:link', (_e, kind: ThreadKind, name: string, threadId: string, threadName: string | null) =>
    library.call('linkDiscordThread', kind, name, threadId, threadName)
  )
  handle('discord:unlink', (_e, kind: ThreadKind, name: string) => library.call('unlinkDiscordThread', kind, name))
  handle('discord:queue', () => library.call('getDiscordQueue'))
  handle('discord:queue-remove', (_e, ids: number[]) => library.call('removeFromDiscordQueue', ids))
  handle('discord:queue-restore', (_e, rows: Awaited<ReturnType<ThumbGroveApi['removeFromDiscordQueue']>>) => library.call('restoreToDiscordQueue', rows))
  handle('discord:check', () => library.call('startDiscordCheck'))
  handle('discord:upload', (_e, ids: number[], threadId?: string) => library.call('startDiscordUpload', ids, threadId))
  handle('discord:upload-cancel', () => library.call('cancelDiscordUpload'))
  handle('discord:upload-status', () => library.call('getDiscordUploadStatus'))
  handle('discord:history', () => library.call('getDiscordHistory'))
  handle('discord:delete-post', (_e, id: number) => library.call('deleteDiscordPost', id))
  handle('images:copy-path', async (_e, id: number) => {
    const file = await library.call('imageFile', id)
    if (file) clipboard.writeText(file.path)
  })
  handle('images:enqueue', (_e, ids: number[]) => library.call('enqueueFromFolders', ids))
  handle('folders:enqueue', (_e, folderId: number) => library.call('enqueueFolder', folderId))
  handle('images:rename', (_e, requests: Array<{ id: number; name: string }>) => library.call('renameImages', requests))
  handle('images:rename-base', (_e, ids: number[], base: string) => library.call('renameImagesToBase', ids, base))
  handle('images:move', (_e, ids: number[], destination: string) => library.call('moveImages', ids, destination))
  handle('images:delete', async (_e, ids: number[]) => {
    const trashed: number[] = []
    const paths: string[] = []
    try {
      for (const id of ids) {
        const file = await library.call('imageFile', id)
        if (!file) continue
        await shell.trashItem(file.path)
        trashed.push(id)
        paths.push(file.path)
      }
    } finally {
      // Whatever already reached the Recycle Bin is recorded even if a later file fails.
      await library.call('afterImagesTrash', trashed, paths)
    }
    return trashed.length
  })
  handle('tags:get', (_e, id: number) => library.call('getImageTags', id))
  handle('tags:all', () => library.call('getAllTags'))
  handle('tags:set', (_e, id: number, tags: string[]) => library.call('setImageTags', id, tags))
  handle('tags:add', (_e, ids: number[], tags: string[]) => library.call('addImageTags', ids, tags))
  handle('tags:add-folder', (_e, id: number, tags: string[]) => library.call('addFolderTags', id, tags))
  handle('folders:create', (_e, parentId: number, name: string) => library.call('createFolder', parentId, name))
  handle('folders:favorite', (_e, id: number, on: boolean) => library.call('setFolderFavorite', id, on === true))
  handle('folders:favorites', () => library.call('getFavorites'))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#0f1016',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#9a9bb0', height: 38 },
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  window = win
  win.on('closed', () => {
    window = null
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.on('render-process-gone', (_event, details) => writeLog('error', `Window stopped: ${details.reason}`))
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') writeLog('error', `Window: ${event.message}`)
  })

  // Thumb Grove is a single page. External links open in the default browser instead of inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
}

// Two copies could work on the same database and move the same files at once.
if (!app.requestSingleInstanceLock()) app.exit(0)

app.setAppUserModelId('com.thumbgrove.app')

app.on('second-instance', () => {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})

process.on('uncaughtException', (error) => writeLog('error', `Uncaught: ${error.stack ?? error.message}`))
process.on('unhandledRejection', (reason) => writeLog('error', `Unhandled: ${String(reason)}`))

void app.whenReady().then(() => {
  startLog(path.join(app.getPath('userData'), 'logs'))
  writeLog('info', `Thumb Grove ${app.getVersion()} started`)
  const destinationBase = process.env.THUMBGROVE_DESTINATION_ROOT ?? path.join(app.getPath('pictures'), 'Thumb Grove')
  library = new LibraryClient(
    {
      dataDir: app.getPath('userData'),
      modelRoots: [
        path.join(app.getPath('userData'), 'models'),
        ...(process.env.THUMBGROVE_MODEL_ROOT ? [process.env.THUMBGROVE_MODEL_ROOT] : [])
      ],
      // Checks run against a local stand-in, so a throwaway library can never reach the real Discord.
      ...(process.env.THUMBGROVE_DATA_DIR ? { discordApiBase: process.env.THUMBGROVE_DISCORD_API ?? 'http://127.0.0.1:9' } : {}),
      defaults: {
        autoApprove: false,
        charactersRoot: path.join(destinationBase, 'Characters'),
        setsRoot: path.join(destinationBase, 'Sets')
      }
    },
    (event: LibraryEvent) => window?.webContents.send('library:event', event),
    (message) => writeLog('error', message),
    (error) => {
      // Without the library worker nothing in the app can work, so say why and close.
      writeLog('error', `Library stopped: ${error.stack ?? error.message}`)
      dialog.showErrorBox('Thumb Grove could not continue', error.message)
      app.quit()
    }
  )
  protocol.handle('thumbgrove', handleImageRequest)
  registerHandlers()
  void loadDiscordToken()
  createWindow()
  startUpdater((status) => window?.webContents.send('updates:status', status))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  void library?.stop()
})
