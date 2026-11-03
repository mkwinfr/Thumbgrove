import { Worker } from 'node:worker_threads'
import type { LibraryEvent } from '../../shared/api'
import type { ServiceConfig } from './service'
import type { WorkerMethods } from './worker'

type Pending = { resolve(value: unknown): void; reject(error: Error): void }

/** Calls the library worker from the main process, so heavy work never blocks the window. */
export class LibraryClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor(config: ServiceConfig, onEvent: (event: LibraryEvent) => void, onLog: (message: string) => void, onFailure: (error: Error) => void) {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: config })
    this.worker.on('message', (message: { id?: number; result?: unknown; error?: string; event?: LibraryEvent; log?: string }) => {
      if (message.log) {
        onLog(message.log)
        return
      }
      if (message.event) {
        onEvent(message.event)
        return
      }
      const call = this.pending.get(message.id!)
      if (!call) return
      this.pending.delete(message.id!)
      if (message.error !== undefined) call.reject(new Error(message.error))
      else call.resolve(message.result)
    })
    this.worker.on('error', (error) => {
      for (const call of this.pending.values()) call.reject(error as Error)
      this.pending.clear()
      onFailure(error as Error)
    })
  }

  call<M extends keyof WorkerMethods>(method: M, ...args: Parameters<WorkerMethods[M]>): Promise<Awaited<ReturnType<WorkerMethods[M]>>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.worker.postMessage({ id, method, args })
    })
  }

  stop(): Promise<number> {
    return this.worker.terminate()
  }
}
