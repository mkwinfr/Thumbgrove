import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiscordClient, DiscordError } from '../src/main/discord/client'
import sharp from 'sharp'
import { downloadAttachment } from '../src/main/discord/remote'
import { DiscordService } from '../src/main/discord/service'
import type { ReviewStore } from '../src/main/library/reviews'
import { Library } from './discordHelpers'

const GUILD = '100000000000000001'
const CHARACTERS = '100000000000000002'
const SETS = '100000000000000003'
const FERN_THREAD = '100000000000000011'
const BEACH_THREAD = '100000000000000012'

interface Call {
  method: string
  url: string
  auth: string | null
  payload: Record<string, unknown> | null
  fileName: string | null
  fileNames: string[]
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init })
}

/** A stand-in for Discord that records every request. Nothing here goes near the network. */
class FakeDiscord {
  calls: Call[] = []
  nextId = 500000000000000000n
  channelType = 15
  flags = 0
  failFor = new Map<string, number>()
  rateLimitOnce = false
  failNetworkOnce = false
  /** Posts per thread, newest first. */
  messages = new Map<string, Array<{ id: string; [key: string]: unknown }>>()
  files = new Map<string, Buffer>()
  downloads: string[] = []
  unreadable = new Set<string>()
  premiumTier = 0

  posts(): Call[] {
    return this.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (this.failNetworkOnce) {
      this.failNetworkOnce = false
      throw new TypeError('network down')
    }
    let payload: Record<string, unknown> | null = null
    let fileName: string | null = null
    let fileNames: string[] = []
    if (init?.body instanceof FormData) {
      payload = JSON.parse(String(init.body.get('payload_json')))
      fileName = (init.body.get('files[0]') as File | null)?.name ?? null
      fileNames = [...init.body.keys()].filter((key) => key.startsWith('files[')).map((key) => (init.body as FormData).get(key) as File).map((file) => file.name)
    } else if (typeof init?.body === 'string') {
      payload = JSON.parse(init.body)
    }
    this.calls.push({ method, url, auth: new Headers(init?.headers).get('authorization'), payload, fileName, fileNames })
    if (this.rateLimitOnce && method === 'POST') {
      this.rateLimitOnce = false
      return json({ retry_after: 0.01 }, { status: 429 })
    }
    if (this.files.has(url)) {
      this.downloads.push(url)
      return new Response(new Uint8Array(this.files.get(url)!))
    }
    const list = url.match(/channels\/(\d+)\/messages\?limit=(\d+)(?:&before=(\d+))?$/)
    if (method === 'GET' && list) {
      const [, thread, limit, before] = list
      if (this.unreadable.has(thread!)) return json({ message: 'Missing Access', code: 50001 }, { status: 403 })
      const all = this.messages.get(thread!) ?? []
      const start = before ? all.findIndex((m) => m.id === before) + 1 : 0
      return json(all.slice(start, start + Number(limit)))
    }
    if (url.endsWith('/users/@me')) return json({ username: 'Thumb GroveBot', id: 'bot' })
    if (url.endsWith(`/guilds/${GUILD}`)) return json({ premium_tier: this.premiumTier })
    if (url.endsWith(`/guilds/${GUILD}/channels`)) {
      return json([{ id: CHARACTERS, name: 'characters', type: 15 }, { id: '1', name: 'Category', type: 4 }, { id: SETS, name: 'sets', type: 0 }])
    }
    if (url.endsWith(`/guilds/${GUILD}/threads/active`)) {
      return json({ threads: [{ id: FERN_THREAD, name: 'Fern', parent_id: CHARACTERS }, { id: BEACH_THREAD, name: 'Beach', parent_id: SETS }] })
    }
    if (method === 'GET' && (url.endsWith(`/channels/${CHARACTERS}`) || url.endsWith(`/channels/${SETS}`))) {
      return json({ guild_id: GUILD, type: this.channelType, flags: this.flags, available_tags: [{ id: '42', name: 'Anime' }] })
    }
    if (method === 'POST' && url.includes('/threads') && !url.includes('/messages/')) return json({ id: String(++this.nextId), name: payload?.name })
    if (method === 'POST' && url.includes('/messages/') && url.endsWith('/threads')) return json({ id: String(++this.nextId), name: payload?.name })
    if (method === 'POST' && url.endsWith('/messages')) {
      const thread = url.match(/channels\/(\d+)/)?.[1] ?? ''
      const remaining = this.failFor.get(thread) ?? 0
      if (remaining > 0) {
        this.failFor.set(thread, remaining - 1)
        return json({ message: 'Missing Permissions', code: 50013 }, { status: 403 })
      }
      const id = String(++this.nextId)
      this.messages.set(thread, [{ id, type: 0, content: 'x', timestamp: '2026-01-02T03:04:05.000Z', author: { id: 'bot' }, attachments: [] }, ...(this.messages.get(thread) ?? [])])
      return json({ id })
    }
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return json({ message: 'Not found' }, { status: 404 })
  }
}

let base: string
let index: string
let library: Library
let discord: DiscordService
let reviews: ReviewStore
let fake: FakeDiscord

function image(relative: string, content: string): number {
  const file = path.join(index, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return library.addImageForTest(file)
}

function setUp(): void {
  ;({ library, reviews } = Library.open(base, index))
  discord = new DiscordService({
    library,
    reviews,
    emit: () => undefined,
    fetcher: fake.fetch,
    apiBase: 'https://discord.test/api',
    sleep: async () => undefined
  })
  discord.setToken('secret-token')
  discord.saveConfig({ guildId: GUILD, parents: { characters: CHARACTERS, sets: SETS } })
}

beforeEach(async () => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbgrove-discord-')))
  index = path.join(base, 'Index')
  fs.mkdirSync(index)
  fake = new FakeDiscord()
  setUp()
})

afterEach(() => {
  library.close()
  fs.rmSync(base, { recursive: true, force: true })
})

async function upload(ids: number[]): Promise<void> {
  discord.startUpload(ids)
  await discord.uploadFinished
}

describe('the Discord client', () => {
  const make = (fetcher: typeof fetch, waits: number[] = []) =>
    new DiscordClient(() => 'token', fetcher, 'https://discord.test', async (ms) => void waits.push(ms))

  it('waits and retries when rate limited', async () => {
    let calls = 0
    const waits: number[] = []
    const client = make(async () => (++calls === 1 ? json({ retry_after: 2 }, { status: 429 }) : json({ ok: true })), waits)
    expect(await client.request('/x')).toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(waits).toEqual([2000])
  })

  it('gives up after repeated rate limits', async () => {
    const client = make(async () => json({ retry_after: 1 }, { status: 429 }))
    await expect(client.request('/x')).rejects.toThrow(/rate limiting/)
  })

  it('gives up on a very long rate limit instead of hanging', async () => {
    const client = make(async () => json({ retry_after: 3600 }, { status: 429 }))
    await expect(client.request('/x')).rejects.toThrow(/rate limiting/)
  })

  it('pauses before a limit is reached', async () => {
    const waits: number[] = []
    const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '5' }
    const client = make(async () => json({}, { headers }), waits)
    await client.request('/channels/123/messages')
    await client.request('/channels/123/messages')
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(4000)
  })

  it('tracks limits separately per channel', async () => {
    const waits: number[] = []
    const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '5' }
    const client = make(async () => json({}, { headers }), waits)
    await client.request('/channels/123/messages')
    await client.request('/channels/456/messages')
    expect(waits).toEqual([])
  })

  it('retries when Discord or the connection has a temporary problem', async () => {
    let calls = 0
    const client = make(async () => {
      calls++
      if (calls === 1) throw new TypeError('offline')
      if (calls === 2) return json({}, { status: 503 })
      return json({ ok: true })
    })
    expect(await client.request('/x')).toEqual({ ok: true })
    expect(calls).toBe(3)
  })

  it('explains errors without retrying them', async () => {
    let calls = 0
    const client = make(async () => {
      calls++
      return json({ message: 'nope', code: 50013 }, { status: 403 })
    })
    const error = await client.request('/x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DiscordError)
    expect((error as Error).message).toMatch(/permission/)
    expect(calls).toBe(1)
  })

  it('refuses to send anything without a token', async () => {
    const client = new DiscordClient(() => '', async () => json({}))
    await expect(client.request('/x')).rejects.toThrow(/bot token/)
  })
})

describe('setup', () => {
  it('reports the connection and never returns the token', async () => {
    const status = await discord.getStatus()
    expect(status).toMatchObject({ connected: true, username: 'Thumb GroveBot', hasToken: true })
    expect(JSON.stringify(status)).not.toContain('secret-token')
    expect(fake.calls[0]!.auth).toBe('Bot secret-token')
  })

  it('reports a missing token without contacting Discord', async () => {
    discord.setToken('')
    expect(await discord.getStatus()).toMatchObject({ connected: false, hasToken: false })
    expect(fake.calls).toEqual([])
  })

  it('rejects malformed IDs', () => {
    expect(() => discord.saveConfig({ guildId: 'abc', parents: { characters: '', sets: '' } })).toThrow(/17 to 20/)
  })

  it('lists only channels that can hold threads, and threads for the right channel', async () => {
    expect((await discord.getChannels()).map((c) => c.name)).toEqual(['characters', 'sets'])
    expect(await discord.getThreads('characters')).toEqual([{ id: FERN_THREAD, name: 'Fern' }])
  })
})

describe('the queue', () => {
  beforeEach(() => {
    discord.linkThread('characters', 'Fern', FERN_THREAD)
    discord.linkThread('sets', 'Beach Day', BEACH_THREAD)
  })

  it('routes to each character and set, matching names without case', () => {
    const id = image('a.png', 'aaa')
    reviews.enqueueDiscord(id, ['FERN (sousou no frieren)'], 'beach day')
    const [entry] = discord.getQueue()
    expect(entry!.targets.map((t) => t.threadId)).toEqual([FERN_THREAD, BEACH_THREAD])
    expect(entry!.missing).toEqual([])
  })

  it('reports names with no thread', () => {
    const id = image('a.png', 'aaa')
    reviews.enqueueDiscord(id, ['fern', 'stark'], 'Winter')
    const [entry] = discord.getQueue()
    expect(entry!.targets.map((t) => t.name)).toEqual(['Fern'])
    expect(entry!.missing).toEqual([{ kind: 'characters', name: 'Stark' }, { kind: 'sets', name: 'Winter' }])
  })

  it('uses preferred character names for routing', () => {
    reviews.saveName('fern (sousou no frieren)', 'Fern', null)
    discord.linkThread('characters', 'Fern', FERN_THREAD)
    const id = image('a.png', 'aaa')
    reviews.enqueueDiscord(id, ['fern (sousou no frieren)'], null)
    expect(discord.getQueue()[0]!.targets).toHaveLength(1)
  })

  it('queues browsed images from their folder', async () => {
    const inCharacter = image('Characters/Fern/a.png', 'a')
    const inSet = image('Sets/Beach Day/b.png', 'b')
    const elsewhere = image('Other/c.png', 'c')
    expect(await discord.enqueueFromFolders([inCharacter, inSet, elsewhere])).toEqual({ queued: 2, unknown: 1, alreadyPosted: 0 })
    const queue = discord.getQueue()
    expect(queue.map((q) => q.targets[0]!.name)).toEqual(['Fern', 'Beach Day'])
  })

  it('does not queue images already in all their threads, and reports them', async () => {
    const posted = image('Characters/Fern/a.png', 'a')
    const fresh = image('Characters/Fern/b.png', 'b')
    await discord.enqueueFromFolders([posted])
    await upload([posted])
    expect(discord.getQueue()).toEqual([])

    expect(await discord.enqueueFromFolders([posted, fresh])).toEqual({ queued: 1, unknown: 0, alreadyPosted: 1 })
    expect(discord.getQueue().map((q) => q.id)).toEqual([fresh])
    expect(reviews.discordCount()).toBe(1)
  })

  it('reports an image with the same bytes as one already posted, even before it has a hash', async () => {
    const posted = image('Characters/Fern/a.png', 'same')
    const copy = image('Characters/Fern/copy.png', 'same')
    await discord.enqueueFromFolders([posted])
    await upload([posted])
    expect(await discord.enqueueFromFolders([copy])).toEqual({ queued: 0, unknown: 0, alreadyPosted: 1 })
    expect(reviews.discordCount()).toBe(0)
  })

  it('keeps an image that still needs one of its threads', async () => {
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Fern'], null)
    await upload([id])
    reviews.enqueueDiscord(id, ['Fern', 'Stark'], null)
    expect(await discord.removeAlreadyQueuedPosted([id])).toBe(0)
    expect(discord.getQueue()[0]!.missing.map((m) => m.name)).toEqual(['Stark'])
  })

  it('clears images stuck from an earlier version when the app starts', async () => {
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Fern'], null)
    await upload([id])
    reviews.enqueueDiscord(id, ['Fern'], null)
    expect(reviews.discordCount()).toBe(1)
    new DiscordService({ library, reviews, emit: () => undefined, fetcher: fake.fetch, apiBase: 'https://discord.test/api', sleep: async () => undefined })
    expect(reviews.discordCount()).toBe(0)
  })

  it('queues a whole set folder for the set alone', async () => {
    const first = image('Sets/Beach Day/a.png', 'a')
    const second = image('Sets/Beach Day/More/b.png', 'b')
    const folder = library.getFolderByPath(path.join(index, 'Sets', 'Beach Day'))!
    expect(await discord.enqueueFolder(folder.id)).toEqual({ queued: 2, unknown: 0, alreadyPosted: 0 })
    const queue = discord.getQueue()
    expect(queue.map((q) => q.id).sort()).toEqual([first, second].sort())
    expect(queue.flatMap((q) => q.targets.map((t) => t.name))).toEqual(['Beach Day', 'Beach Day'])
    expect(queue.flatMap((q) => q.missing)).toEqual([])
  })
})

describe('uploading', () => {
  beforeEach(() => {
    discord.linkThread('characters', 'Fern', FERN_THREAD)
    discord.linkThread('sets', 'Beach Day', BEACH_THREAD)
  })

  it('posts to each thread, records history, and leaves the queue', async () => {
    const id = image('Fern 1.png', 'image bytes')
    reviews.enqueueDiscord(id, ['Fern'], 'Beach Day')
    await upload([id])

    const posts = fake.posts()
    expect(posts.map((p) => p.url)).toEqual([
      `https://discord.test/api/channels/${FERN_THREAD}/messages`,
      `https://discord.test/api/channels/${BEACH_THREAD}/messages`
    ])
    expect(posts[0]).toMatchObject({ fileName: 'Fern 1.png', payload: { content: 'Fern 1.png', allowed_mentions: { parse: [] } } })
    expect(discord.getQueue()).toEqual([])
    expect(discord.getHistory().map((h) => h.targetName).sort()).toEqual(['Beach Day', 'Fern'])
    expect(discord.getUploadStatus()).toMatchObject({ phase: 'complete', posted: 2, failed: 0 })
    expect(fs.existsSync(path.join(index, 'Fern 1.png'))).toBe(true)
  })

  it('does not post the same image to the same thread twice', async () => {
    const first = image('a.png', 'same bytes')
    const second = image('copy.png', 'same bytes')
    reviews.enqueueDiscord(first, ['Fern'], null)
    reviews.enqueueDiscord(second, ['Fern'], null)
    await upload([first, second])
    expect(fake.posts()).toHaveLength(1)
    expect(discord.getUploadStatus()).toMatchObject({ posted: 1, duplicates: 1 })
    expect(discord.getQueue()).toEqual([])
  })

  it('still posts identical images to different threads', async () => {
    const first = image('a.png', 'same bytes')
    const second = image('b.png', 'same bytes')
    reviews.enqueueDiscord(first, ['Fern'], null)
    reviews.enqueueDiscord(second, [], 'Beach Day')
    await upload([first, second])
    expect(fake.posts()).toHaveLength(2)
  })

  it('keeps a failed image queued, then a retry only posts what is left', async () => {
    const id = image('a.png', 'bytes')
    reviews.enqueueDiscord(id, ['Fern'], 'Beach Day')
    fake.failFor.set(BEACH_THREAD, 1)
    await upload([id])

    expect(discord.getUploadStatus()).toMatchObject({ posted: 1, failed: 1 })
    expect(discord.getQueue()[0]!.lastError).toMatch(/permission/)
    expect(discord.getQueue()[0]!.targets.find((t) => t.name === 'Fern')!.posted).toBe(true)

    await upload([id])
    expect(fake.posts().filter((p) => p.url.includes(FERN_THREAD))).toHaveLength(1)
    expect(discord.getQueue()).toEqual([])
    expect(discord.getUploadStatus()).toMatchObject({ posted: 1, duplicates: 1, failed: 0 })
  })

  it('one failure does not stop the rest', async () => {
    const bad = image('a.png', 'a')
    const good = image('b.png', 'b')
    reviews.enqueueDiscord(bad, [], 'Beach Day')
    reviews.enqueueDiscord(good, ['Fern'], null)
    fake.failFor.set(BEACH_THREAD, 99)
    await upload([bad, good])
    expect(discord.getQueue().map((q) => q.id)).toEqual([bad])
    expect(discord.getUploadStatus()).toMatchObject({ posted: 1, failed: 1, done: 2 })
  })

  it('does not post anything for an image with no connected thread', async () => {
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Stark'], null)
    await upload([id])
    expect(fake.posts()).toEqual([])
    expect(discord.getQueue()[0]!.lastError).toMatch(/No thread for Stark/)
    expect(discord.getUploadStatus()).toMatchObject({ failed: 1, done: 1 })
  })

  it('posts a set to its thread when its characters have no threads, and keeps them queued', async () => {
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Stark', 'Himmel'], 'Beach Day')
    await upload([id])

    expect(fake.posts().map((p) => p.url)).toEqual([`https://discord.test/api/channels/${BEACH_THREAD}/messages`])
    expect(discord.getUploadStatus()).toMatchObject({ posted: 1, failed: 0 })
    const [entry] = discord.getQueue()
    expect(entry!.targets[0]).toMatchObject({ name: 'Beach Day', posted: true })
    expect(entry!.missing.map((m) => m.name)).toEqual(['Stark', 'Himmel'])
    expect(entry!.lastError).toBeNull()
  })

  it('leaves the queue once a thread connected later has the image too', async () => {
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Stark'], 'Beach Day')
    await upload([id])
    discord.linkThread('characters', 'Stark', '100000000000000013')
    await upload([id])
    expect(fake.posts().map((p) => p.url)).toEqual([
      `https://discord.test/api/channels/${BEACH_THREAD}/messages`,
      'https://discord.test/api/channels/100000000000000013/messages'
    ])
    expect(discord.getQueue()).toEqual([])
  })

  it('uploads to one thread when asked, leaving the others for later', async () => {
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Fern'], 'Beach Day')
    discord.startUpload([id], BEACH_THREAD)
    await discord.uploadFinished

    expect(fake.posts().map((p) => p.url)).toEqual([`https://discord.test/api/channels/${BEACH_THREAD}/messages`])
    const targets = discord.getQueue()[0]!.targets
    expect(targets.find((t) => t.name === 'Fern')!.posted).toBe(false)
    expect(targets.find((t) => t.name === 'Beach Day')!.posted).toBe(true)
  })

  it('posts up to ten images in each message, per thread', async () => {
    const ids = Array.from({ length: 23 }, (_, i) => image(`${i}.png`, `image ${i}`))
    for (const id of ids) reviews.enqueueDiscord(id, ['Fern'], null)
    const other = image('set.png', 'set image')
    reviews.enqueueDiscord(other, [], 'Beach Day')
    await upload([...ids, other])

    const posts = fake.posts()
    expect(posts.map((p) => p.fileNames.length)).toEqual([10, 10, 3, 1])
    expect(posts[0]!.fileNames.slice(0, 2)).toEqual(['0.png', '1.png'])
    expect(posts[0]!.payload).toEqual({ allowed_mentions: { parse: [] } })
    expect(posts[3]!.payload).toMatchObject({ content: 'set.png' })
    expect(discord.getUploadStatus()).toMatchObject({ posted: 24, done: 24, total: 24, failed: 0 })
    expect(discord.getQueue()).toEqual([])
    expect(new Set(discord.getHistory().map((h) => h.messageId)).size).toBe(4)
  })

  it('keeps each message within the server upload limit', async () => {
    library.setSetting('uploadLimitMb', 1)
    const ids = ['a', 'b', 'c'].map((n) => image(`${n}.png`, n.repeat(450 * 1024)))
    for (const id of ids) reviews.enqueueDiscord(id, ['Fern'], null)
    await upload(ids)
    expect(fake.posts().map((p) => p.fileNames)).toEqual([['a.png', 'b.png'], ['c.png']])
  })

  it('keeps a whole failed message queued, and carries on with the next', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => image(`${i}.png`, `image ${i}`))
    for (const id of ids) reviews.enqueueDiscord(id, ['Fern'], null)
    fake.failFor.set(FERN_THREAD, 1)
    await upload(ids)

    expect(discord.getUploadStatus()).toMatchObject({ posted: 1, failed: 10, done: 11 })
    expect(discord.getQueue().map((q) => q.id)).toEqual(ids.slice(0, 10))
    expect(discord.getQueue()[0]!.lastError).toMatch(/permission/)
  })

  it('deleting a post forgets every image in that message', async () => {
    const ids = ['a', 'b'].map((n) => image(`${n}.png`, n))
    const lone = image('c.png', 'c')
    for (const id of ids) reviews.enqueueDiscord(id, ['Fern'], null)
    reviews.enqueueDiscord(lone, [], 'Beach Day')
    await upload([...ids, lone])
    const entry = discord.getHistory().find((h) => h.name === 'a.png')!

    await discord.deletePost(entry.id)

    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    expect(discord.getHistory().map((h) => h.name)).toEqual(['c.png'])
  })

  it('reports a deleted file instead of failing silently', async () => {
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Fern'], null)
    fs.rmSync(path.join(index, 'a.png'))
    await upload([id])
    expect(discord.getUploadStatus().failed).toBe(1)
    expect(fake.posts()).toEqual([])
  })

  it('survives a rate limit partway through', async () => {
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Fern'], null)
    fake.rateLimitOnce = true
    await upload([id])
    expect(discord.getUploadStatus()).toMatchObject({ posted: 1, failed: 0 })
  })

  it('can be cancelled between images', async () => {
    const ids = ['a', 'b', 'c'].map((n) => image(`${n}.png`, n))
    for (const id of ids) reviews.enqueueDiscord(id, ['Fern'], null)
    discord.startUpload(ids)
    discord.cancelUpload()
    await discord.uploadFinished
    expect(discord.getUploadStatus().phase).toBe('cancelled')
    expect(discord.getQueue().length).toBeGreaterThan(0)
  })

  it('refuses to start two uploads', async () => {
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Fern'], null)
    discord.startUpload([id])
    expect(() => discord.startUpload([id])).toThrow(/already running/)
    await discord.uploadFinished
  })
})

describe('checking what is already on Discord', () => {
  const pixels = (seed: number, width = 40, height = 50) =>
    sharp({ create: { width, height, channels: 3, background: { r: seed, g: 90, b: 200 - seed } } }).png().toBuffer()

  async function realImage(relative: string, bytes: Buffer): Promise<number> {
    const file = path.join(index, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
    return library.addImageForTest(file)
  }

  function attachment(id: string, bytes: Buffer, width = 40, height = 50, filename = 'on discord.png') {
    fake.files.set(`https://cdn.discordapp.com/${id}`, bytes)
    return { id, filename, url: `https://cdn.discordapp.com/${id}`, size: bytes.length, width, height, content_type: 'image/png' }
  }

  function post(threadId: string, id: string, attachments: unknown[], authorId = 'someone') {
    const list = fake.messages.get(threadId) ?? []
    list.unshift({ id, type: 0, content: 'x', timestamp: '2026-01-02T03:04:05.000Z', author: { id: authorId }, attachments })
    fake.messages.set(threadId, list)
  }

  beforeEach(() => {
    discord.linkThread('characters', 'Fern', FERN_THREAD)
    discord.linkThread('sets', 'Beach Day', BEACH_THREAD)
  })

  async function check(): Promise<void> {
    discord.startCheck()
    await discord.uploadFinished
  }

  it('removes an image someone already posted and adds it to history, posting nothing', async () => {
    const bytes = await pixels(10)
    const id = await realImage('a.png', bytes)
    reviews.enqueueDiscord(id, ['Fern'], null)
    post(FERN_THREAD, '900', [attachment('1', bytes)])

    await check()

    expect(discord.getQueue()).toEqual([])
    expect(fake.posts()).toEqual([])
    expect(discord.getUploadStatus()).toMatchObject({ phase: 'complete', mode: 'check', duplicates: 1, warning: null })
    expect(discord.getHistory()[0]).toMatchObject({ messageId: '900', threadId: FERN_THREAD, targetName: 'Fern' })
    expect(fs.existsSync(path.join(index, 'a.png'))).toBe(true)
  })

  it('matches when Discord has a different file with the same pixels', async () => {
    const original = await pixels(20)
    const withMetadata = await sharp(original).withExif({ IFD0: { Copyright: 'x' } }).png().toBuffer()
    expect(original.equals(withMetadata)).toBe(false)
    const id = await realImage('a.png', withMetadata)
    reviews.enqueueDiscord(id, ['Fern'], null)
    post(FERN_THREAD, '900', [attachment('1', original)])
    await check()
    expect(discord.getQueue()).toEqual([])
  })

  it('keeps a similar image, even with the same name and size', async () => {
    const id = await realImage('on discord.png', await pixels(30))
    reviews.enqueueDiscord(id, ['Fern'], null)
    post(FERN_THREAD, '900', [attachment('1', await pixels(31))])
    await check()
    expect(discord.getQueue().map((q) => q.id)).toEqual([id])
    expect(discord.getUploadStatus().duplicates).toBe(0)
  })

  it('keeps an image that is only in some of its threads, and only posts the rest', async () => {
    const bytes = await pixels(40)
    const id = await realImage('a.png', bytes)
    reviews.enqueueDiscord(id, ['Fern'], 'Beach Day')
    post(FERN_THREAD, '900', [attachment('1', bytes)])

    await check()
    const [entry] = discord.getQueue()
    expect(entry!.targets.find((t) => t.name === 'Fern')!.posted).toBe(true)
    expect(entry!.targets.find((t) => t.name === 'Beach Day')!.posted).toBe(false)

    await upload([id])
    expect(fake.posts().map((p) => p.url)).toEqual([`https://discord.test/api/channels/${BEACH_THREAD}/messages`])
    expect(discord.getQueue()).toEqual([])
  })

  it('records what is already posted, but keeps an image still waiting on a thread', async () => {
    const bytes = await pixels(45)
    const id = await realImage('a.png', bytes)
    reviews.enqueueDiscord(id, ['Stark'], 'Beach Day')
    post(BEACH_THREAD, '900', [attachment('1', bytes)])

    await check()

    const [entry] = discord.getQueue()
    expect(entry!.targets[0]).toMatchObject({ name: 'Beach Day', posted: true })
    expect(entry!.missing.map((m) => m.name)).toEqual(['Stark'])
  })

  it('does not count an image posted to a different thread', async () => {
    const bytes = await pixels(50)
    const id = await realImage('a.png', bytes)
    reviews.enqueueDiscord(id, ['Fern'], null)
    post(BEACH_THREAD, '900', [attachment('1', bytes)])
    await check()
    expect(discord.getQueue()).toHaveLength(1)
  })

  it('checks before an upload and skips what is already there', async () => {
    const posted = await pixels(60)
    const first = await realImage('a.png', posted)
    const second = await realImage('b.png', await pixels(61))
    reviews.enqueueDiscord(first, ['Fern'], null)
    reviews.enqueueDiscord(second, ['Fern'], null)
    post(FERN_THREAD, '900', [attachment('1', posted)])

    await upload([first, second])

    expect(fake.posts().map((p) => p.fileName)).toEqual(['b.png'])
    expect(discord.getUploadStatus()).toMatchObject({ phase: 'complete', mode: 'upload', posted: 1, duplicates: 1 })
    expect(discord.getQueue()).toEqual([])
  })

  it('still uploads, with a warning, when a thread cannot be read', async () => {
    const id = await realImage('a.png', await pixels(70))
    reviews.enqueueDiscord(id, ['Fern'], null)
    fake.unreadable.add(FERN_THREAD)
    await upload([id])
    expect(fake.posts()).toHaveLength(1)
    expect(discord.getUploadStatus().warning).toMatch(/Could not check everything\. Fern/)
  })

  it('reads threads longer than one page', async () => {
    const bytes = await pixels(80)
    const id = await realImage('a.png', bytes)
    reviews.enqueueDiscord(id, ['Fern'], null)
    post(FERN_THREAD, String(1000), [attachment('old', bytes)])
    for (let n = 1001; n < 1150; n++) post(FERN_THREAD, String(n), [])
    await check()
    expect(discord.getQueue()).toEqual([])
    expect(fake.calls.filter((c) => c.method === 'GET' && c.url.includes(`/channels/${FERN_THREAD}/messages`))).toHaveLength(2)
  })

  it('only downloads attachments the same size as a queued image, once each', async () => {
    const id = await realImage('a.png', await pixels(90))
    reviews.enqueueDiscord(id, ['Fern'], null)
    post(FERN_THREAD, '900', [attachment('other-size', await pixels(90, 60, 60), 60, 60), attachment('same-size', await pixels(91))])
    await check()
    await check()
    expect(fake.downloads).toEqual(['https://cdn.discordapp.com/same-size'])
  })

  it('never sends the bot token when downloading', async () => {
    const id = await realImage('a.png', await pixels(100))
    reviews.enqueueDiscord(id, ['Fern'], null)
    post(FERN_THREAD, '900', [attachment('1', await pixels(100))])
    await check()
    expect(fake.calls.filter((c) => c.url.startsWith('https://cdn.discordapp.com')).map((c) => c.auth)).toEqual([null])
  })

  it('forgets posts that were deleted from Discord, so the image can be posted again', async () => {
    const bytes = await pixels(110)
    const other = await realImage('other.png', await pixels(111))
    reviews.enqueueDiscord(other, ['Fern'], null)
    post(FERN_THREAD, '900', [attachment('1', bytes)])
    await check()
    fake.messages.set(FERN_THREAD, [])
    await check()
    const id = await realImage('a.png', bytes)
    reviews.enqueueDiscord(id, ['Fern'], null)
    await check()
    expect(discord.getQueue().map((q) => q.id).sort()).toEqual([other, id].sort())
  })

  it('posts an image again after its post was deleted directly on Discord', async () => {
    const bytes = await pixels(115)
    const id = await realImage('a.png', bytes)
    reviews.enqueueDiscord(id, ['Fern'], null)
    await upload([id])
    expect(discord.getHistory()).toHaveLength(1)

    fake.messages.set(FERN_THREAD, [])
    reviews.enqueueDiscord(id, ['Fern'], null)
    await upload([id])

    expect(fake.posts()).toHaveLength(2)
    expect(discord.getHistory()).toHaveLength(1)
  })

  it('keeps the history when a thread cannot be read', async () => {
    const id = await realImage('a.png', await pixels(116))
    reviews.enqueueDiscord(id, ['Fern'], null)
    await upload([id])
    fake.unreadable.add(FERN_THREAD)
    reviews.enqueueDiscord(id, ['Fern'], null)
    await check()
    expect(discord.getHistory()).toHaveLength(1)
    expect(discord.getQueue()).toEqual([])
  })

  it('warns when other people\'s posts are hidden from the bot', async () => {
    const id = await realImage('a.png', await pixels(120))
    reviews.enqueueDiscord(id, ['Fern'], null)
    const list = [{ id: '900', type: 0, content: '', timestamp: '2026-01-02T03:04:05.000Z', author: { id: 'someone' }, attachments: [] }]
    fake.messages.set(FERN_THREAD, list)
    await check()
    expect(discord.getUploadStatus().warning).toMatch(/Message Content Intent/)
    expect(discord.getQueue()).toHaveLength(1)
  })

  it('does not warn about the bot\'s own posts', async () => {
    const id = await realImage('a.png', await pixels(130))
    reviews.enqueueDiscord(id, ['Fern'], null)
    fake.messages.set(FERN_THREAD, [{ id: '900', type: 0, content: '', timestamp: '2026-01-02T03:04:05.000Z', author: { id: 'bot' }, attachments: [] }])
    await check()
    expect(discord.getUploadStatus().warning).toBeNull()
  })

  it('removes images already in the local history without any download', async () => {
    const bytes = await pixels(140)
    const first = await realImage('a.png', bytes)
    reviews.enqueueDiscord(first, ['Fern'], null)
    await upload([first])
    const copy = await realImage('copy.png', bytes)
    reviews.enqueueDiscord(copy, ['Fern'], null)
    fake.downloads.length = 0
    await check()
    expect(discord.getQueue()).toEqual([])
    expect(fake.downloads).toEqual([])
  })

  it('refuses attachment links not hosted by Discord', async () => {
    await expect(downloadAttachment('https://evil.example/x.png', fake.fetch, false)).rejects.toThrow(/not hosted/)
    await expect(downloadAttachment('http://cdn.discordapp.com/x.png', fake.fetch, false)).rejects.toThrow(/not hosted/)
    expect(fake.calls).toEqual([])
  })

  it('removing from the queue can be undone, and changes nothing else', async () => {
    const id = await realImage('a.png', await pixels(150))
    reviews.enqueueDiscord(id, ['Fern'], 'Beach Day')
    const before = discord.getQueue()
    const removed = discord.removeFromQueue([id])
    expect(discord.getQueue()).toEqual([])
    expect(fake.calls).toEqual([])
    expect(fs.existsSync(path.join(index, 'a.png'))).toBe(true)
    discord.restoreToQueue(removed)
    expect(discord.getQueue()).toEqual(before)
  })

  it('can be cancelled', async () => {
    const id = await realImage('a.png', await pixels(160))
    reviews.enqueueDiscord(id, ['Fern'], null)
    discord.startCheck()
    expect(() => discord.startUpload([id])).toThrow(/already running/)
    discord.cancelUpload()
    await discord.uploadFinished
    expect(discord.getUploadStatus().phase).toBe('cancelled')
    expect(fake.posts()).toEqual([])
  })
})

describe('upload size', () => {
  beforeEach(() => discord.linkThread('characters', 'Fern', FERN_THREAD))

  it('flags an image over the limit and does not try to post it', async () => {
    library.setSetting('uploadLimitMb', 1)
    const id = image('big.png', 'x'.repeat(2 * 1024 * 1024))
    reviews.enqueueDiscord(id, ['Fern'], null)
    expect(discord.getQueue()[0]!.tooLarge).toBe(true)
    await upload([id])
    expect(fake.posts()).toEqual([])
    expect(discord.getQueue()[0]!.lastError).toMatch(/2 MB, over this server's 1 MB limit/)
  })

  it('follows the server boost level unless a limit is set', async () => {
    expect(discord.uploadLimitBytes()).toBe(10 * 1024 * 1024)
    fake.premiumTier = 2
    await discord.getStatus()
    expect(discord.uploadLimitBytes()).toBe(50 * 1024 * 1024)
    fake.premiumTier = 3
    await discord.getStatus()
    expect(discord.uploadLimitBytes()).toBe(100 * 1024 * 1024)
    library.setSetting('uploadLimitMb', 25)
    expect(discord.uploadLimitBytes()).toBe(25 * 1024 * 1024)
  })

  it('can skip the check before uploading', async () => {
    library.setSetting('checkBeforeUpload', false)
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Fern'], null)
    await upload([id])
    expect(fake.calls.some((c) => c.method === 'GET' && c.url.includes('/messages'))).toBe(false)
    expect(fake.posts()).toHaveLength(1)
  })
})

describe('threads', () => {
  it('requires an image for a character thread', async () => {
    await expect(discord.createThread('characters', 'Fern', [], null)).rejects.toThrow(/Choose an image/)
  })

  it('creates a forum thread with an image and tags, then links it', async () => {
    const id = image('a.png', 'a')
    const link = await discord.createThread('characters', 'Fern', ['42'], id)
    const call = fake.calls.find((c) => c.method === 'POST')!
    expect(call.url).toBe(`https://discord.test/api/channels/${CHARACTERS}/threads`)
    expect(call.fileName).toBe('a.png')
    expect(call.payload).toMatchObject({ name: 'Fern', applied_tags: ['42'] })
    expect(discord.getLinks()).toEqual([link])
  })

  it('starts a text channel thread from a message', async () => {
    fake.channelType = 0
    const id = image('a.png', 'a')
    await discord.createThread('characters', 'Fern', [], id)
    const urls = fake.calls.filter((c) => c.method === 'POST').map((c) => c.url)
    expect(urls[0]).toMatch(new RegExp(`/channels/${CHARACTERS}/messages$`))
    expect(urls[1]).toMatch(/\/messages\/\d+\/threads$/)
  })

  it('allows a set thread without an image', async () => {
    fake.channelType = 0
    await discord.createThread('sets', 'Winter', [], null)
    expect(fake.calls.find((c) => c.method === 'POST')!.payload).toMatchObject({ name: 'Winter', type: 11 })
  })

  it('enforces required tags, valid tags, and the five-tag limit', async () => {
    const id = image('a.png', 'a')
    fake.flags = 16
    await expect(discord.createThread('characters', 'Fern', [], id)).rejects.toThrow(/requires a tag/)
    await expect(discord.createThread('characters', 'Fern', ['999'], id)).rejects.toThrow(/valid forum tags/)
    await expect(discord.createThread('characters', 'Fern', ['1', '2', '3', '4', '5', '6'], id)).rejects.toThrow(/valid forum tags/)
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('refuses a name that is already linked', async () => {
    const id = image('a.png', 'a')
    discord.linkThread('characters', 'Fern', FERN_THREAD)
    await expect(discord.createThread('characters', 'FERN', [], id)).rejects.toThrow(/already linked/)
  })

  it('refuses a channel from another server', async () => {
    discord.saveConfig({ guildId: '100000000000000099', parents: { characters: CHARACTERS, sets: SETS } })
    await expect(discord.getThreadSetup('characters')).rejects.toThrow(/different server/)
  })

  it('unlinks without touching Discord', () => {
    discord.linkThread('characters', 'Fern', FERN_THREAD)
    discord.unlinkThread('characters', 'fern')
    expect(discord.getLinks()).toEqual([])
    expect(fake.calls).toEqual([])
  })
})

describe('history', () => {
  it('deletes the post from Discord but keeps the image', async () => {
    discord.linkThread('characters', 'Fern', FERN_THREAD)
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Fern'], null)
    await upload([id])
    const [entry] = discord.getHistory()
    await discord.deletePost(entry!.id)
    expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', url: `https://discord.test/api/channels/${FERN_THREAD}/messages/${entry!.messageId}` })
    expect(discord.getHistory()).toEqual([])
    expect(fs.existsSync(path.join(index, 'a.png'))).toBe(true)
  })

  it('keeps the record when Discord refuses the deletion', async () => {
    discord.linkThread('characters', 'Fern', FERN_THREAD)
    const id = image('a.png', 'a')
    reviews.enqueueDiscord(id, ['Fern'], null)
    await upload([id])
    const original = fake.fetch
    fake.fetch = async () => json({ message: 'no', code: 50013 }, { status: 403 })
    library.close()
    setUp()
    await expect(discord.deletePost(discord.getHistory()[0]!.id)).rejects.toThrow(/permission/)
    expect(discord.getHistory()).toHaveLength(1)
    fake.fetch = original
  })
})

