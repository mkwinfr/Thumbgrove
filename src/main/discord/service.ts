import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type {
  ChannelOption,
  DiscordConfig,
  DiscordLink,
  DiscordStatus,
  HistoryEntry,
  LibraryEvent,
  QueueEntry,
  ThreadKind,
  ThreadOption,
  ThreadSetup,
  UploadStatus
} from '../../shared/api'
import { displayName, nameKey } from '../../shared/naming'
import { pathKey, type Library } from '../library/library'
import type { QueuedImage, ReviewStore } from '../library/reviews'
import { DiscordClient } from './client'
import { downloadAttachment, imageFingerprint, isImageAttachment, looksHidden, savedFingerprint, type ImageFingerprint, type RemoteMessage } from './remote'

const ID = /^\d{17,20}$/
const MAX_THREAD_PHOTO_BYTES = 25 * 1024 * 1024
const MAX_FORUM_TAGS = 5
const HISTORY_LIMIT = 200
const ALLOWED_PARENT_TYPES = new Set([0, 15, 16])
const FORUM_TYPES = new Set([15, 16])
const REQUIRES_TAG_FLAG = 16
const DEFAULT_UPLOAD_MB = 10
/** Upload limits by server boost level. Levels 0 and 1 use the default. */
const TIER_UPLOAD_MB: Record<number, number> = { 2: 50, 3: 100 }

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

const IDLE_UPLOAD: UploadStatus = { phase: 'idle', mode: 'upload', done: 0, total: 0, name: '', posted: 0, duplicates: 0, failed: 0, warning: null }

export interface DiscordServiceOptions {
  library: Library
  reviews: ReviewStore
  emit(event: LibraryEvent): void
  fetcher?: typeof fetch
  apiBase?: string
  sleep?(ms: number): Promise<void>
}

function mimeOf(name: string): string {
  return MIME_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
}

export async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

/** The Discord queue, thread links, uploads, history, and the import from the earlier version. */
export class DiscordService {
  private token = ''
  private readonly client: DiscordClient
  private upload: UploadStatus = { ...IDLE_UPLOAD }
  private cancelRequested = false
  private readonly library: Library
  private readonly reviews: ReviewStore
  private readonly fetcher: typeof fetch

  constructor(private readonly options: DiscordServiceOptions) {
    this.library = options.library
    this.reviews = options.reviews
    this.fetcher = options.fetcher ?? fetch
    this.client = new DiscordClient(() => this.token, options.fetcher, options.apiBase, options.sleep)
  }

  private get db() {
    return this.library.db
  }

  private emit(): void {
    this.options.emit({ type: 'discord' })
    // The queue count on the navigation comes from the review state.
    this.options.emit({ type: 'reviews' })
  }

  setToken(token: string): void {
    this.token = token.trim()
  }

  getConfig(): DiscordConfig {
    return {
      guildId: this.library.getValue('discordGuildId') ?? '',
      parents: {
        characters: this.library.getValue('discordCharactersChannel') ?? '',
        sets: this.library.getValue('discordSetsChannel') ?? ''
      }
    }
  }

  saveConfig(config: DiscordConfig): void {
    for (const id of [config.guildId, config.parents.characters, config.parents.sets]) {
      if (id && !ID.test(id)) throw new Error('Discord IDs are 17 to 20 digits long.')
    }
    this.library.setValue('discordGuildId', config.guildId)
    this.library.setValue('discordCharactersChannel', config.parents.characters)
    this.library.setValue('discordSetsChannel', config.parents.sets)
    this.emit()
  }

  async getStatus(): Promise<DiscordStatus> {
    const base = {
      hasToken: Boolean(this.token),
      config: this.getConfig(),
    }
    if (!this.token) return { ...base, connected: false, username: '', error: null, uploadLimitBytes: this.uploadLimitBytes() }
    try {
      const user = await this.client.request<{ username: string }>('/users/@me')
      await this.rememberServerTier()
      return { ...base, connected: true, username: user.username, error: null, uploadLimitBytes: this.uploadLimitBytes() }
    } catch (error) {
      return { ...base, connected: false, username: '', error: (error as Error).message, uploadLimitBytes: this.uploadLimitBytes() }
    }
  }

  /** The server's boost level sets how large an upload can be. */
  private async rememberServerTier(): Promise<void> {
    const { guildId } = this.getConfig()
    if (!ID.test(guildId)) return
    try {
      const guild = await this.client.request<{ premium_tier?: number }>(`/guilds/${guildId}`)
      this.library.setValue('discordServerTier', String(guild.premium_tier ?? 0))
    } catch {
      // The saved level or the safest limit still applies.
    }
  }

  uploadLimitBytes(): number {
    const { uploadLimitMb } = this.library.getSettings()
    const tier = Number(this.library.getValue('discordServerTier') ?? 0)
    const mb = uploadLimitMb > 0 ? uploadLimitMb : (TIER_UPLOAD_MB[tier] ?? DEFAULT_UPLOAD_MB)
    return mb * 1024 * 1024
  }

  // Thread links

  getLinks(): DiscordLink[] {
    const rows = this.db.prepare('SELECT kind, name, thread_id, thread_name FROM discord_links ORDER BY kind, name_key').all() as Array<{ kind: ThreadKind; name: string; thread_id: string; thread_name: string | null }>
    return rows.map((row) => ({ kind: row.kind, name: row.name, threadId: row.thread_id, threadName: row.thread_name }))
  }

  linkThread(kind: ThreadKind, name: string, threadId: string, threadName: string | null = null): void {
    const clean = name.trim()
    if (!clean || clean.length > 120) throw new Error('Enter a name for this thread.')
    if (!ID.test(threadId)) throw new Error('Choose a valid thread.')
    this.db
      .prepare(
        `INSERT INTO discord_links (kind, name_key, name, thread_id, thread_name) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, name_key) DO UPDATE SET name = excluded.name, thread_id = excluded.thread_id, thread_name = excluded.thread_name`
      )
      .run(kind, nameKey(clean), clean, threadId, threadName)
    this.emit()
  }

  unlinkThread(kind: ThreadKind, name: string): void {
    this.db.prepare('DELETE FROM discord_links WHERE kind = ? AND name_key = ?').run(kind, nameKey(name))
    this.emit()
  }

  async getChannels(): Promise<ChannelOption[]> {
    const { guildId } = this.getConfig()
    if (!ID.test(guildId)) throw new Error('Enter the server ID first.')
    const channels = await this.client.request<Array<{ id: string; name: string; type: number }>>(`/guilds/${guildId}/channels`)
    return channels
      .filter((channel) => ALLOWED_PARENT_TYPES.has(channel.type))
      .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Active threads under the channel for this kind. Discord doesn't list archived threads here. */
  async getThreads(kind: ThreadKind): Promise<ThreadOption[]> {
    const config = this.getConfig()
    if (!ID.test(config.guildId)) throw new Error('Enter the server ID first.')
    const parent = config.parents[kind]
    const result = await this.client.request<{ threads: Array<{ id: string; name: string; parent_id: string }> }>(`/guilds/${config.guildId}/threads/active`)
    return result.threads
      .filter((thread) => thread.parent_id === parent)
      .map((thread) => ({ id: thread.id, name: thread.name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async getThreadSetup(kind: ThreadKind): Promise<ThreadSetup> {
    const config = this.getConfig()
    const id = config.parents[kind]
    if (!ID.test(id)) throw new Error('Choose the channel in Discord settings first.')
    const parent = await this.client.request<{ guild_id: string; type: number; flags?: number; available_tags?: Array<{ id: string; name: string }> }>(`/channels/${id}`)
    if (parent.guild_id !== config.guildId) throw new Error('That channel belongs to a different server. Check Discord settings.')
    if (!ALLOWED_PARENT_TYPES.has(parent.type)) throw new Error('Choose a text, forum, or media channel, not a category or thread.')
    return {
      channelId: id,
      isForum: FORUM_TYPES.has(parent.type),
      requiresTag: Boolean((parent.flags ?? 0) & REQUIRES_TAG_FLAG),
      tags: (parent.available_tags ?? []).map((tag) => ({ id: tag.id, name: tag.name }))
    }
  }

  /** Creates a thread and links it. Character threads must start with an image. */
  async createThread(kind: ThreadKind, name: string, tagIds: string[], photoId: number | null): Promise<DiscordLink> {
    const clean = name.trim()
    if (!clean || clean.length > 100) throw new Error('Enter a thread name of up to 100 characters.')
    if (this.getLinks().some((link) => link.kind === kind && nameKey(link.name) === nameKey(clean))) {
      throw new Error('A thread is already linked to this name.')
    }
    const setup = await this.getThreadSetup(kind)
    if (tagIds.length > MAX_FORUM_TAGS || tagIds.some((id) => !setup.tags.some((tag) => tag.id === id))) throw new Error('Choose up to five valid forum tags.')
    if (setup.isForum && setup.requiresTag && !tagIds.length) throw new Error('This forum requires a tag.')
    if (kind === 'characters' && photoId === null) throw new Error('Choose an image for the character thread.')

    const file = photoId === null ? null : this.library.imageFile(photoId)
    if (photoId !== null && !file) throw new Error('That image is no longer available.')
    let photo: { bytes: Buffer; name: string } | null = null
    if (file) {
      const bytes = await fsp.readFile(file.path)
      if (bytes.length > MAX_THREAD_PHOTO_BYTES) throw new Error('Choose an image under 25 MB for the thread.')
      photo = { bytes, name: path.basename(file.path) }
    }

    const form = (payload: unknown): FormData => {
      const data = new FormData()
      data.append('files[0]', new Blob([new Uint8Array(photo!.bytes)], { type: mimeOf(photo!.name) }), photo!.name)
      data.append('payload_json', JSON.stringify(payload))
      return data
    }
    const json = (payload: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const threadBody = { name: clean, auto_archive_duration: 1440 }
    let thread: { id: string; name: string }

    if (setup.isForum) {
      const message = {
        content: clean,
        allowed_mentions: { parse: [] },
        ...(photo ? { attachments: [{ id: 0, filename: photo.name }] } : {})
      }
      const body = { ...threadBody, message, ...(tagIds.length ? { applied_tags: tagIds } : {}) }
      thread = await this.client.request(`/channels/${setup.channelId}/threads`, photo ? { method: 'POST', body: form(body) } : json(body))
    } else if (photo) {
      const starter = await this.client.request<{ id: string }>(`/channels/${setup.channelId}/messages`, {
        method: 'POST',
        body: form({ content: clean, allowed_mentions: { parse: [] } })
      })
      thread = await this.client.request(`/channels/${setup.channelId}/messages/${starter.id}/threads`, json(threadBody))
    } else {
      thread = await this.client.request(`/channels/${setup.channelId}/threads`, json({ ...threadBody, type: 11 }))
    }
    this.linkThread(kind, clean, thread.id, thread.name)
    return { kind, name: clean, threadId: thread.id, threadName: thread.name }
  }

  // Queue

  getQueue(): QueueEntry[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.name, i.mtime_ms, i.size, i.hash, q.characters, q.set_name, q.last_error
         FROM discord_queue q JOIN images i ON i.id = q.image_id
         WHERE i.missing = 0 ORDER BY q.queued_at, i.sort_key`
      )
      .all() as Array<{ id: number; name: string; mtime_ms: number; size: number; hash: string | null; characters: string; set_name: string | null; last_error: string | null }>
    const limit = this.uploadLimitBytes()
    const names = this.reviews.getNames()
    const links = new Map(this.getLinks().map((link) => [`${link.kind}:${nameKey(link.name)}`, link]))
    const posted = new Set((this.db.prepare('SELECT hash, thread_id FROM discord_uploads').all() as Array<{ hash: string; thread_id: string }>).map((row) => `${row.hash}|${row.thread_id}`))

    return rows.map((row) => {
      const characters = (JSON.parse(row.characters) as string[]).map((raw) => displayName(raw, names))
      const wanted: Array<{ kind: ThreadKind; name: string }> = [
        ...[...new Map(characters.map((name) => [nameKey(name), name])).values()].map((name) => ({ kind: 'characters' as const, name })),
        ...(row.set_name ? [{ kind: 'sets' as const, name: row.set_name }] : [])
      ]
      const targets: QueueEntry['targets'] = []
      const missing: QueueEntry['missing'] = []
      for (const item of wanted) {
        const link = links.get(`${item.kind}:${nameKey(item.name)}`)
        if (!link) missing.push(item)
        else if (!targets.some((target) => target.threadId === link.threadId)) {
          targets.push({
            kind: item.kind,
            name: link.name,
            threadId: link.threadId,
            threadName: link.threadName,
            posted: row.hash !== null && posted.has(`${row.hash}|${link.threadId}`)
          })
        }
      }
      return { id: row.id, name: row.name, mtimeMs: row.mtime_ms, size: row.size, tooLarge: row.size > limit, targets, missing, lastError: row.last_error }
    })
  }

  /** Takes images out of the queue and returns them, so the removal can be undone. */
  removeFromQueue(ids: number[]): QueuedImage[] {
    const removed = this.reviews.queueSnapshot(ids)
    this.reviews.dequeueDiscord(ids)
    this.emit()
    return removed
  }

  restoreToQueue(rows: QueuedImage[]): void {
    this.reviews.restoreQueue(rows)
    this.emit()
  }

  // Checking what's already on Discord

  /** Records every image in a thread, and forgets any that are no longer there. */
  private async readThread(threadId: string, botId: string): Promise<{ urls: Map<string, string>; hidden: boolean }> {
    const urls = new Map<string, string>()
    const seen = new Set<string>()
    const seenMessages = new Set<string>()
    let hidden = false
    let before: string | null = null
    const upsert = this.db.prepare(
      `INSERT INTO discord_attachments (id, thread_id, message_id, name, width, height, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id, message_id = excluded.message_id`
    )
    for (;;) {
      const page: RemoteMessage[] = await this.client.request(`/channels/${threadId}/messages?limit=100${before ? `&before=${before}` : ''}`)
      this.library.transaction(() => {
        for (const message of page) {
          seenMessages.add(message.id)
          if (looksHidden(message, botId)) hidden = true
          for (const attachment of message.attachments.filter(isImageAttachment)) {
            seen.add(attachment.id)
            urls.set(attachment.id, attachment.url)
            upsert.run(attachment.id, threadId, message.id, attachment.filename, attachment.width ?? null, attachment.height ?? null, Date.parse(message.timestamp) || Date.now())
          }
        }
      })
      if (page.length < 100 || this.cancelRequested) break
      before = page[page.length - 1]!.id
    }
    // A partial read can't tell which images are gone.
    if (!this.cancelRequested) {
      const known = this.db.prepare('SELECT id FROM discord_attachments WHERE thread_id = ?').all(threadId) as Array<{ id: string }>
      const remove = this.db.prepare('DELETE FROM discord_attachments WHERE id = ?')
      // A post deleted on Discord leaves the history too, so its image can be posted again.
      const history = this.db.prepare('SELECT id, message_id FROM discord_uploads WHERE thread_id = ?').all(threadId) as Array<{ id: number; message_id: string }>
      const forget = this.db.prepare('DELETE FROM discord_uploads WHERE id = ?')
      this.library.transaction(() => {
        for (const { id } of known) if (!seen.has(id)) remove.run(id)
        for (const { id, message_id } of history) if (!seenMessages.has(message_id)) forget.run(id)
      })
    }
    return { urls, hidden }
  }

  /** Finds the attachment with these pixels. Only attachments of the same size are ever downloaded. */
  private async findAttachment(threadId: string, fingerprint: ImageFingerprint, urls: Map<string, string>): Promise<{ message_id: string; posted_at: number } | null> {
    const rows = this.db
      .prepare('SELECT id, message_id, pixel_hash, posted_at FROM discord_attachments WHERE thread_id = ? AND width = ? AND height = ?')
      .all(threadId, fingerprint.width, fingerprint.height) as Array<{ id: string; message_id: string; pixel_hash: string | null; posted_at: number }>
    const known = rows.find((row) => row.pixel_hash === fingerprint.hash)
    if (known) return known
    for (const row of rows) {
      if (row.pixel_hash) continue
      const url = urls.get(row.id)
      if (!url) continue
      const bytes = await downloadAttachment(url, this.fetcher, Boolean(this.options.apiBase))
      const remote = await imageFingerprint(bytes)
      this.db.prepare('UPDATE discord_attachments SET pixel_hash = ? WHERE id = ?').run(remote.hash, row.id)
      if (remote.hash === fingerprint.hash) return row
      if (this.cancelRequested) break
    }
    return null
  }

  /**
   * Compares queued images with what's on Discord and takes out any already in all their threads.
   * Returns how many were removed. A thread that can't be read is reported and left for the upload.
   */
  private async removeAlreadyPosted(ids: number[] | null): Promise<{ removed: number; warning: string | null }> {
    const wanted = ids ? new Set(ids) : null
    const queue = this.getQueue().filter((entry) => !wanted || wanted.has(entry.id))
    const threads = new Map<string, string>()
    for (const entry of queue) for (const target of entry.targets) threads.set(target.threadId, target.name)

    const problems: string[] = []
    const reads = new Map<string, Map<string, string>>()
    let hidden = false
    const bot = await this.client.request<{ id: string }>('/users/@me')
    let index = 0
    for (const [threadId, name] of threads) {
      if (this.cancelRequested) break
      this.updateUpload({ name, done: index++, total: threads.size })
      try {
        const result = await this.readThread(threadId, bot.id)
        reads.set(threadId, result.urls)
        hidden ||= result.hidden
      } catch (error) {
        problems.push(`${name}: ${(error as Error).message}`)
      }
    }

    const record = this.db.prepare('INSERT OR IGNORE INTO discord_uploads (hash, image_id, name, target_name, thread_id, message_id, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    let removed = 0
    let compared = 0
    for (const entry of queue) {
      if (this.cancelRequested) break
      this.updateUpload({ name: entry.name, done: compared++, total: queue.length })
      const file = this.library.imageFile(entry.id)
      if (!file || entry.missing.length || !entry.targets.length) continue
      try {
        const hash = await this.fileHash(entry.id, file.path)
        const fingerprint = await savedFingerprint(this.library, entry.id, file.path)
        let allPosted = true
        for (const target of entry.targets) {
          if (this.db.prepare('SELECT 1 FROM discord_uploads WHERE hash = ? AND thread_id = ?').get(hash, target.threadId)) continue
          const urls = reads.get(target.threadId)
          const match = urls ? await this.findAttachment(target.threadId, fingerprint, urls) : null
          if (match) record.run(hash, entry.id, entry.name, target.name, target.threadId, match.message_id, match.posted_at)
          else allPosted = false
        }
        if (allPosted) {
          this.reviews.dequeueDiscord([entry.id])
          removed++
        }
      } catch (error) {
        // An image that can't be compared stays queued. Uploading reports it if it's truly unreadable.
        problems.push(`${entry.name}: ${(error as Error).message}`)
      }
    }
    const notes = [
      ...(hidden ? ['Some posts by other people could not be read. Turn on Message Content Intent for your bot in the Discord Developer Portal so they can be checked.'] : []),
      ...(problems.length ? [`Could not check everything. ${problems[0]}`] : [])
    ]
    return { removed, warning: notes.join(' ') || null }
  }

  /** Runs the check by itself in the background, without posting anything. */
  startCheck(): void {
    if (this.isBusy()) throw new Error('An upload or check is already running.')
    if (!this.token) throw new Error('Add the bot token in Discord settings first.')
    this.cancelRequested = false
    this.updateUpload({ ...IDLE_UPLOAD, phase: 'checking' })
    this.uploadFinished = (async () => {
      try {
        const { removed, warning } = await this.removeAlreadyPosted(null)
        this.updateUpload({ phase: this.cancelRequested ? 'cancelled' : 'complete', mode: 'check', name: '', duplicates: removed, warning })
      } catch (error) {
        this.updateUpload({ phase: 'complete', mode: 'check', name: '', warning: (error as Error).message })
      }
      this.emit()
    })()
  }

  private isBusy(): boolean {
    return ['checking', 'running', 'cancelling'].includes(this.upload.phase)
  }

  /**
   * Queues images chosen while browsing. The destination comes from where the file lives: inside a
   * character folder it's that character, and inside a set folder it's that set.
   */
  enqueueFromFolders(ids: number[]): { queued: number; unknown: number } {
    const settings = this.library.getSettings()
    const childOf = (root: string, file: string): string | null => {
      const prefix = `${pathKey(root)}\\`
      const key = pathKey(file)
      if (!key.startsWith(prefix)) return null
      const parts = path.resolve(file).slice(prefix.length).split(path.sep)
      return parts.length >= 2 ? parts[0]! : null
    }
    let queued = 0
    let unknown = 0
    for (const id of ids) {
      const file = this.library.imageFile(id)
      if (!file) continue
      const character = childOf(settings.charactersRoot, file.path)
      const set = childOf(settings.setsRoot, file.path)
      if (!character && !set) {
        unknown++
        continue
      }
      this.reviews.enqueueDiscord(id, character ? [character] : [], set)
      queued++
    }
    this.emit()
    return { queued, unknown }
  }

  // Upload

  getUploadStatus(): UploadStatus {
    return this.upload
  }

  private updateUpload(change: Partial<UploadStatus>): void {
    this.upload = { ...this.upload, ...change }
    this.options.emit({ type: 'upload', status: this.upload })
  }

  cancelUpload(): void {
    if (this.upload.phase === 'running' || this.upload.phase === 'checking') {
      this.cancelRequested = true
      this.updateUpload({ phase: 'cancelling' })
    }
  }

  private async fileHash(id: number, file: string): Promise<string> {
    const row = this.db.prepare('SELECT hash FROM images WHERE id = ?').get(id) as { hash: string | null } | undefined
    if (row?.hash) return row.hash
    const hash = await hashFile(file)
    this.db.prepare('UPDATE images SET hash = ? WHERE id = ?').run(hash, id)
    return hash
  }

  private async post(file: string, threadId: string): Promise<{ id: string }> {
    const name = path.basename(file)
    const bytes = await fsp.readFile(file)
    const data = new FormData()
    data.append('files[0]', new Blob([new Uint8Array(bytes)], { type: mimeOf(name) }), name)
    data.append('payload_json', JSON.stringify({ content: name, allowed_mentions: { parse: [] } }))
    return this.client.request(`/channels/${threadId}/messages`, { method: 'POST', body: data })
  }

  /** Starts uploading in the background and returns straight away. Progress arrives as events. */
  startUpload(ids: number[]): void {
    if (this.isBusy()) throw new Error('An upload is already running.')
    if (!this.token) throw new Error('Add the bot token in Discord settings first.')
    const unique = [...new Set(ids)]
    this.cancelRequested = false
    this.updateUpload({ ...IDLE_UPLOAD, phase: 'checking', total: unique.length })
    this.uploadFinished = this.runUpload(unique)
  }

  /** Resolves when the current upload ends. */
  uploadFinished: Promise<void> = Promise.resolve()

  private async runUpload(ids: number[]): Promise<void> {
    let done = 0
    let posted = 0
    let duplicates = 0
    let failed = 0
    let warning: string | null = null
    if (this.library.getSettings().checkBeforeUpload) {
      try {
        const check = await this.removeAlreadyPosted(ids)
        duplicates = check.removed
        warning = check.warning
        if (check.removed) this.emit()
      } catch (error) {
        // The upload still goes ahead. Each post has its own error if Discord really is unreachable.
        warning = `Could not check Discord first. ${(error as Error).message}`
      }
    }
    if (!this.cancelRequested) this.updateUpload({ phase: 'running', done: 0, total: ids.length, duplicates })
    const setError = this.db.prepare('UPDATE discord_queue SET last_error = ? WHERE image_id = ?')
    for (const id of ids) {
      if (this.cancelRequested) break
      const entry = this.getQueue().find((item) => item.id === id)
      if (!entry) {
        done++
        continue
      }
      this.updateUpload({ name: entry.name, done })
      try {
        if (entry.missing.length) throw new Error(`No thread for ${entry.missing.map((m) => m.name).join(', ')}.`)
        if (!entry.targets.length) throw new Error('This image has no character or set.')
        if (entry.tooLarge) {
          const toMb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')
          throw new Error(`This image is ${toMb(entry.size)} MB, over this server's ${toMb(this.uploadLimitBytes())} MB limit.`)
        }
        const file = this.library.imageFile(id)
        if (!file) throw new Error('This image is no longer available.')
        const hash = await this.fileHash(id, file.path)
        for (const target of entry.targets) {
          // A target finished on an earlier attempt isn't posted twice when a retry happens.
          const already = this.db.prepare('SELECT 1 FROM discord_uploads WHERE hash = ? AND thread_id = ?').get(hash, target.threadId)
          if (already) {
            duplicates++
            continue
          }
          const message = await this.post(file.path, target.threadId)
          this.db
            .prepare('INSERT INTO discord_uploads (hash, image_id, name, target_name, thread_id, message_id, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(hash, id, path.basename(file.path), target.name, target.threadId, message.id, Date.now())
          posted++
        }
        this.reviews.dequeueDiscord([id])
      } catch (error) {
        setError.run((error as Error).message, id)
        failed++
      }
      done++
      this.updateUpload({ done, posted, duplicates, failed })
      this.emit()
    }
    this.updateUpload({ phase: this.cancelRequested ? 'cancelled' : 'complete', mode: 'upload', done, posted, duplicates, failed, name: '', warning })
    this.emit()
  }

  // History

  getHistory(): HistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.name, u.target_name, u.thread_id, u.message_id, u.posted_at, i.id AS image_id, i.mtime_ms
         FROM discord_uploads u LEFT JOIN images i ON i.id = u.image_id AND i.missing = 0
         ORDER BY u.posted_at DESC, u.id DESC LIMIT ?`
      )
      .all(HISTORY_LIMIT) as Array<{ id: number; name: string; target_name: string; thread_id: string; message_id: string; posted_at: number; image_id: number | null; mtime_ms: number | null }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      targetName: row.target_name,
      threadId: row.thread_id,
      messageId: row.message_id,
      postedAt: row.posted_at,
      imageId: row.image_id,
      imageVersion: row.mtime_ms
    }))
  }

  /** Deletes the post from Discord. The image on this computer stays. */
  async deletePost(id: number): Promise<void> {
    const row = this.db.prepare('SELECT thread_id, message_id FROM discord_uploads WHERE id = ?').get(id) as { thread_id: string; message_id: string } | undefined
    if (!row) throw new Error('This post is not in the history.')
    await this.client.request(`/channels/${row.thread_id}/messages/${row.message_id}`, { method: 'DELETE' })
    this.db.prepare('DELETE FROM discord_uploads WHERE id = ?').run(id)
    this.emit()
  }
}
