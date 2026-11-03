import { Worker } from 'node:worker_threads'
import type { Candidate, RecognitionStatus } from '../../shared/api'
import type { CharacterName } from '../../shared/naming'
import type { EligibleImage } from '../library/reviews'
import { downloadModel, findModel, modelSize } from './model'

export type TaggerMessage =
  | { type: 'provider'; provider: string }
  | { type: 'progress'; done: number; total: number; name: string }
  | { type: 'result'; id: number; candidates: Candidate[] }
  | { type: 'image-error'; id: number; error: string }
  | { type: 'complete'; cancelled: boolean }
  | { type: 'error'; error: string }

export interface TaggerHandle {
  cancel(): void
}

export type TaggerRunner = (
  job: { modelRoot: string; images: EligibleImage[]; names: CharacterName[] },
  onMessage: (message: TaggerMessage) => void,
  onExit: (error?: Error) => void
) => TaggerHandle

export interface JobEvents {
  onStatus(status: RecognitionStatus): void
  onResult(id: number, candidates: Candidate[], error: string | null): void
  onFinished(results: Map<number, Candidate[]>, cancelled: boolean): Promise<number>
  names(): CharacterName[]
}

const realRunner: TaggerRunner = (job, onMessage, onExit) => {
  // The model runs on its own thread, and is only in memory while a scan is running.
  const worker = new Worker(new URL('./tagger.js', import.meta.url), { workerData: job })
  worker.on('message', onMessage)
  worker.on('error', (error) => onExit(error as Error))
  worker.on('exit', () => onExit())
  return {
    cancel: () => worker.postMessage('cancel')
  }
}

const IDLE: Omit<RecognitionStatus, 'modelReady' | 'modelSize'> = { phase: 'idle', done: 0, total: 0, name: '', provider: '', error: null, autoApproved: 0 }

/** Runs one recognition job or model download at a time and reports progress. */
export class RecognitionJobs {
  private state = { ...IDLE }
  private handle: TaggerHandle | null = null
  private abort: AbortController | null = null

  constructor(
    private readonly modelRoots: string[],
    private readonly events: JobEvents,
    private readonly runner: TaggerRunner = realRunner
  ) {}

  status(): RecognitionStatus {
    return { ...this.state, modelReady: findModel(this.modelRoots) !== null, modelSize: modelSize() }
  }

  get busy(): boolean {
    return ['downloading', 'loading', 'running', 'cancelling'].includes(this.state.phase)
  }

  private update(change: Partial<typeof IDLE>): void {
    this.state = { ...this.state, ...change }
    this.events.onStatus(this.status())
  }

  download(): void {
    if (this.busy) throw new Error('Recognition is busy. Wait for it to finish or cancel it.')
    this.abort = new AbortController()
    this.update({ ...IDLE, phase: 'downloading', total: modelSize() })
    downloadModel(this.modelRoots[0]!, (done, total) => this.update({ done, total }), this.abort.signal)
      .then(() => this.update({ phase: 'complete' }))
      .catch((error: Error) =>
        this.update(this.abort?.signal.aborted ? { phase: 'cancelled' } : { phase: 'error', error: error.message })
      )
      .finally(() => {
        this.abort = null
      })
  }

  start(images: EligibleImage[]): void {
    if (this.busy) throw new Error('Recognition is busy. Wait for it to finish or cancel it.')
    const modelRoot = findModel(this.modelRoots)
    if (!modelRoot) throw new Error('MODEL_MISSING')
    this.update({ ...IDLE, phase: 'loading', total: images.length })

    const results = new Map<number, Candidate[]>()
    let cancelled = false
    let settled = false
    const finish = (error?: string): void => {
      if (settled) return
      settled = true
      this.handle = null
      // Suggestions found before a failure stay in the queue, and auto-approve still runs on them.
      this.events
        .onFinished(results, cancelled)
        .then((autoApproved) =>
          this.update(
            error ? { phase: 'error', error, autoApproved } : { phase: cancelled ? 'cancelled' : 'complete', done: results.size, autoApproved }
          )
        )
        .catch((failure: Error) => this.update({ phase: 'error', error: failure.message }))
    }
    this.handle = this.runner(
      { modelRoot, images, names: this.events.names() },
      (message) => {
        if (message.type === 'provider') {
          this.update({ provider: message.provider })
        } else if (message.type === 'progress') {
          this.update({ phase: this.state.phase === 'cancelling' ? 'cancelling' : 'running', done: message.done, total: message.total, name: message.name })
        } else if (message.type === 'result') {
          results.set(message.id, message.candidates)
          this.events.onResult(message.id, message.candidates, null)
        } else if (message.type === 'image-error') {
          this.events.onResult(message.id, [], message.error)
        } else if (message.type === 'complete') {
          cancelled = message.cancelled
          finish()
        } else if (message.type === 'error') {
          finish(message.error)
        }
      },
      (error) => finish(error?.message ?? 'Recognition stopped unexpectedly. Completed suggestions were kept.')
    )
  }

  cancel(): void {
    if (this.abort) this.abort.abort()
    if (this.handle) {
      this.handle.cancel()
      this.update({ phase: 'cancelling' })
    }
  }
}
