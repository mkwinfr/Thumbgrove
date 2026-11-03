import crypto from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import type { Library } from '../library/library'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
const DISCORD_FILE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

export interface RemoteAttachment {
  id: string
  filename: string
  url: string
  size: number
  width?: number | null
  height?: number | null
  content_type?: string
}

export interface RemoteMessage {
  id: string
  type: number
  content: string
  timestamp: string
  author: { id: string }
  attachments: RemoteAttachment[]
  embeds?: unknown[]
  sticker_items?: unknown[]
}

export interface ImageFingerprint {
  hash: string
  width: number
  height: number
}

/**
 * Identifies an image by its decoded pixels. Discord can strip metadata from an upload, which changes
 * the file but not the picture. Similar images, like variations in a set, don't match.
 */
export async function imageFingerprint(input: string | Buffer): Promise<ImageFingerprint> {
  const { data, info } = await sharp(input, { page: 0, pages: 1, failOn: 'none' }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const hash = crypto.createHash('sha256').update(`${info.width}x${info.height}:`).update(data).digest('hex')
  return { hash, width: info.width, height: info.height }
}

/** An image's fingerprint, saved so it's only worked out once. Editing the file clears it. */
export async function savedFingerprint(library: Library, id: number, file: string): Promise<ImageFingerprint> {
  const row = library.db.prepare('SELECT pixel_hash FROM images WHERE id = ?').get(id) as { pixel_hash: string | null } | undefined
  const saved = row?.pixel_hash?.split('|')
  if (saved?.length === 3) return { hash: saved[0]!, width: Number(saved[1]), height: Number(saved[2]) }
  const fingerprint = await imageFingerprint(file)
  library.db.prepare('UPDATE images SET pixel_hash = ? WHERE id = ?').run(`${fingerprint.hash}|${fingerprint.width}|${fingerprint.height}`, id)
  return fingerprint
}

export function isImageAttachment(attachment: RemoteAttachment): boolean {
  return Boolean(attachment.content_type?.startsWith('image/')) || IMAGE_EXTENSIONS.has(path.extname(attachment.filename).toLowerCase())
}

/**
 * True for a post from someone else that came back with nothing in it. Discord empties other people's
 * messages unless the bot has the Message Content intent, so their images can't be seen.
 */
export function looksHidden(message: RemoteMessage, botId: string): boolean {
  return (
    message.author.id !== botId &&
    (message.type === 0 || message.type === 19) &&
    !message.content &&
    !message.attachments.length &&
    !message.embeds?.length &&
    !message.sticker_items?.length
  )
}

/** Downloads a file from Discord's file servers. The bot token is never sent with these requests. */
export async function downloadAttachment(url: string, fetcher: typeof fetch, allowAnyHost: boolean): Promise<Buffer> {
  const parsed = new URL(url)
  if (!allowAnyHost && (parsed.protocol !== 'https:' || !DISCORD_FILE_HOSTS.has(parsed.hostname))) {
    throw new Error('That attachment is not hosted by Discord.')
  }
  const response = await fetcher(url)
  if (!response.ok) throw new Error(`Could not download an attachment (${response.status}).`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('An attachment was too large to compare.')
  return bytes
}
