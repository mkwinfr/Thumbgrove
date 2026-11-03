import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_BYTES = 2 * 1024 * 1024

let logFile: string | null = null

export function startLog(folder: string): void {
  fs.mkdirSync(folder, { recursive: true })
  logFile = path.join(folder, 'thumbgrove.log')
}

/** Takes out anything that could be a Discord token, in case one ever appears in a message. */
export function scrub(message: string): string {
  return message.replace(/Bot\s+[\w.-]+/g, 'Bot [hidden]').replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/g, '[hidden]')
}

/** Adds a line to the log. Logging must never be what breaks the app, so failures are ignored. */
export function writeLog(level: 'info' | 'error', message: string): void {
  if (!logFile) return
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.old`)
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${scrub(message)}\n`)
  } catch {
    // Nothing useful can be done here.
  }
}
