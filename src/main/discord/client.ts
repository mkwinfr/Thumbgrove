const MAX_RETRY_WAIT_MS = 60_000
const MAX_RATE_LIMIT_RETRIES = 5
const MAX_SERVER_RETRIES = 3
const SERVER_RETRY_MS = 1000

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number
  ) {
    super(message)
  }
}

function explain(status: number, code: number | undefined, message: string | undefined, details: string[]): string {
  if (status === 401) return 'Discord rejected the bot token. Check it in Discord settings.'
  if (status === 413 || code === 40005) return 'This image is too large for this Discord server.'
  if (code === 50001 || code === 50013) return 'The bot does not have permission to do this in that channel.'
  if (code === 10003) return 'That channel or thread no longer exists.'
  const text = message ?? `Discord returned ${status}.`
  return details.length ? `${text} (${details.join('; ')})` : text
}

function collectErrors(value: unknown, trail = ''): string[] {
  if (!value || typeof value !== 'object') return []
  const found: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (key === '_errors' && Array.isArray(child)) {
      found.push(`${trail}: ${child.map((e: { message?: string }) => e.message).join(', ')}`)
    } else {
      found.push(...collectErrors(child, trail ? `${trail}.${key}` : key))
    }
  }
  return found
}

/**
 * Talks to the Discord API. It waits out rate limits instead of failing, pauses before a limit is
 * hit, and retries when Discord itself has a temporary problem.
 */
export class DiscordClient {
  private readonly bucketReady = new Map<string, number>()

  constructor(
    private readonly getToken: () => string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = 'https://discord.com/api/v10',
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  /** Discord tracks limits per channel, so each channel waits separately. */
  private bucketFor(method: string, route: string): string {
    return `${method} ${route.match(/^\/(channels|guilds)\/\d+/)?.[0] ?? route}`
  }

  async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    const token = this.getToken()
    if (!token) throw new Error('Add the bot token in Discord settings first.')
    const bucket = this.bucketFor(init.method ?? 'GET', route)
    let rateLimited = 0
    let serverFailures = 0

    for (;;) {
      const readyAt = this.bucketReady.get(bucket) ?? 0
      if (readyAt > Date.now()) await this.sleep(readyAt - Date.now())

      let response: Response
      try {
        response = await this.fetcher(`${this.baseUrl}${route}`, {
          ...init,
          headers: { Authorization: `Bot ${token}`, ...init.headers }
        })
      } catch {
        if (++serverFailures > MAX_SERVER_RETRIES) throw new Error('Could not reach Discord. Check your connection.')
        await this.sleep(SERVER_RETRY_MS * serverFailures)
        continue
      }

      if (response.headers.get('x-ratelimit-remaining') === '0') {
        const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'))
        if (Number.isFinite(resetAfter)) this.bucketReady.set(bucket, Date.now() + resetAfter * 1000)
      }

      if (response.status === 429) {
        const body = (await response.json().catch(() => ({}))) as { retry_after?: number }
        const waitMs = Math.max(0, (body.retry_after ?? 1) * 1000)
        if (++rateLimited > MAX_RATE_LIMIT_RETRIES || waitMs > MAX_RETRY_WAIT_MS) {
          throw new DiscordError('Discord is rate limiting this bot. Try again in a few minutes.', 429)
        }
        await this.sleep(waitMs)
        continue
      }

      if (response.status >= 500) {
        if (++serverFailures > MAX_SERVER_RETRIES) throw new DiscordError('Discord is having problems. Try again shortly.', response.status)
        await this.sleep(SERVER_RETRY_MS * serverFailures)
        continue
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string; code?: number; errors?: unknown }
        throw new DiscordError(explain(response.status, body.code, body.message, collectErrors(body.errors)), response.status, body.code)
      }

      return (response.status === 204 ? null : await response.json()) as T
    }
  }
}
