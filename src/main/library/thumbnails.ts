import fs from 'node:fs'
import path from 'node:path'
import { availableParallelism } from 'node:os'
import sharp from 'sharp'

const THUMB_SIZE = 420
const MAX_QUEUED = 300
const CONCURRENCY = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)))

// Sharp's file cache can keep source images locked on Windows, which would block moving them.
sharp.cache(false)
sharp.concurrency(1)

export async function writeThumbnail(source: string, destination: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    await sharp(source, { failOn: 'none', sequentialRead: true })
      .rotate()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 2 })
      .toFile(temporary)
    await fs.promises.rename(temporary, destination)
  } catch (error) {
    await fs.promises.rm(temporary, { force: true })
    throw error
  }
}

interface Job {
  key: string
  source: string
  destination: string
  waiting: Array<{ resolve(file: string): void; reject(error: Error): void }>
}

/**
 * Creates thumbnails on demand into a cache outside the watched folders.
 *
 * The newest request goes first, so what's on screen wins over what was scrolled past. Old requests
 * are dropped when the queue is full. The grid asks again if the user scrolls back.
 */
export class ThumbnailQueue {
  private readonly queue: Job[] = []
  private readonly jobs = new Map<string, Job>()
  private running = 0

  constructor(private readonly cacheDir: string) {}

  private cachePath(id: number, version: number): string {
    return path.join(this.cacheDir, String(id % 256), `${id}-${Math.trunc(version)}.webp`)
  }

  async request(id: number, source: string, version: number): Promise<string> {
    const destination = this.cachePath(id, version)
    if (await fs.promises.access(destination).then(() => true, () => false)) return destination
    return new Promise<string>((resolve, reject) => {
      const existing = this.jobs.get(destination)
      if (existing) {
        existing.waiting.push({ resolve, reject })
        return
      }
      const job: Job = { key: destination, source, destination, waiting: [{ resolve, reject }] }
      this.jobs.set(destination, job)
      this.queue.push(job)
      if (this.queue.length > MAX_QUEUED) {
        const dropped = this.queue.shift()!
        this.jobs.delete(dropped.key)
        for (const waiter of dropped.waiting) waiter.reject(new Error('Thumbnail request dropped.'))
      }
      this.pump()
    })
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length) {
      const job = this.queue.pop()!
      this.running++
      writeThumbnail(job.source, job.destination)
        .then(
          () => job.waiting.forEach((w) => w.resolve(job.destination)),
          (error: Error) => job.waiting.forEach((w) => w.reject(error))
        )
        .finally(() => {
          this.jobs.delete(job.key)
          this.running--
          this.pump()
        })
    }
  }
}
