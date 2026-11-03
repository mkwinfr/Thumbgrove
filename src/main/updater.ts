import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/api'
import { writeLog } from './log'

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

let status: UpdateStatus = { phase: 'unavailable', version: null, percent: 0, error: null }
let report: (status: UpdateStatus) => void = () => undefined

function update(change: Partial<UpdateStatus>): void {
  status = { ...status, ...change }
  report(status)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export function checkForUpdates(): void {
  if (status.phase === 'unavailable' || status.phase === 'checking' || status.phase === 'downloading' || status.phase === 'ready') return
  // Failures also arrive as an error event, which is what reports them.
  void electronUpdater.autoUpdater.checkForUpdates().catch(() => undefined)
}

export function installUpdate(): void {
  if (status.phase === 'ready') electronUpdater.autoUpdater.quitAndInstall(true, true)
}

/** Keeps an installed copy up to date from GitHub Releases. Portable copies and development runs update by hand. */
export function startUpdater(onChange: (status: UpdateStatus) => void): void {
  report = onChange
  // Lets checks run against a local stand-in. It never installs what it downloads.
  const testFeed = process.env.THUMBGROVE_UPDATE_FEED
  const throwaway = Boolean(process.env.THUMBGROVE_DATA_DIR)
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE || (throwaway && !testFeed)) return

  const { autoUpdater } = electronUpdater
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = !testFeed
  if (testFeed) autoUpdater.setFeedURL({ provider: 'generic', url: testFeed })

  autoUpdater.on('checking-for-update', () => update({ phase: 'checking', error: null }))
  autoUpdater.on('update-not-available', () => update({ phase: 'current', version: null }))
  autoUpdater.on('update-available', (info) => {
    writeLog('info', `Downloading update ${info.version}`)
    update({ phase: 'downloading', version: info.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (progress) => update({ phase: 'downloading', percent: Math.round(progress.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    writeLog('info', `Update ${info.version} is ready`)
    update({ phase: 'ready', version: info.version, percent: 100 })
  })
  autoUpdater.on('error', (error) => {
    writeLog('error', `Update check failed: ${error.message}`)
    update({ phase: 'error', error: 'Could not check for updates. Try again later.' })
  })

  update({ phase: 'idle' })
  setTimeout(checkForUpdates, FIRST_CHECK_MS)
  setInterval(checkForUpdates, CHECK_EVERY_MS)
}
