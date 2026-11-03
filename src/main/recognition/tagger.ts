import fs from 'node:fs'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import type { CharacterName } from '../../shared/naming'
import { buildFilenameIndex, characterLabels, combineFilename, predictions } from './tagging'

export interface TaggerJob {
  modelRoot: string
  images: Array<{ id: number; name: string; file: string }>
  names: CharacterName[]
}

const port = parentPort!
const job = workerData as TaggerJob
let cancelled = false
port.on('message', (message) => {
  if (message === 'cancel') cancelled = true
})

sharp.cache(false)

/** The model expects a white-padded square of float pixels in blue, green, red order. */
async function preparePixels(file: string, size: number): Promise<Float32Array> {
  const input = await fs.promises.readFile(file)
  const { data, info } = await sharp(input, { page: 0, pages: 1, failOn: 'error' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: size, height: size, fit: 'contain', kernel: 'cubic', background: '#ffffff' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 3 || data.length !== size * size * 3) throw new Error('Unexpected image pixel format.')
  const pixels = new Float32Array(data.length)
  for (let i = 0; i < data.length; i += 3) {
    pixels[i] = data[i + 2]!
    pixels[i + 1] = data[i + 1]!
    pixels[i + 2] = data[i]!
  }
  return pixels
}

async function createSession(modelFile: string): Promise<{ session: ort.InferenceSession; provider: string }> {
  try {
    const session = await ort.InferenceSession.create(modelFile, {
      executionProviders: ['dml'],
      enableMemPattern: false,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3
    })
    return { session, provider: 'GPU' }
  } catch {
    const session = await ort.InferenceSession.create(modelFile, { executionProviders: ['cpu'], intraOpNumThreads: 4, logSeverityLevel: 3 })
    return { session, provider: 'CPU' }
  }
}

async function run(): Promise<void> {
  const labels = characterLabels(fs.readFileSync(path.join(job.modelRoot, 'selected_tags.csv'), 'utf8'))
  const { session, provider } = await createSession(path.join(job.modelRoot, 'model.onnx'))
  port.postMessage({ type: 'provider', provider })
  const metadata = session.inputMetadata[0] as unknown as { shape?: unknown[] } | undefined
  const size = Number(metadata?.shape?.[1]) || 448
  const filenameIndex = buildFilenameIndex(labels, job.names)
  try {
    for (const [index, image] of job.images.entries()) {
      if (cancelled) break
      port.postMessage({ type: 'progress', done: index, total: job.images.length, name: image.name })
      try {
        const pixels = await preparePixels(image.file, size)
        const input = new ort.Tensor('float32', pixels, [1, size, size, 3])
        const results = await session.run({ [session.inputNames[0]!]: input })
        const scores = results[session.outputNames[0]!]!.data as Float32Array
        port.postMessage({ type: 'result', id: image.id, candidates: combineFilename(image.name, predictions(scores, labels), filenameIndex) })
      } catch (error) {
        port.postMessage({ type: 'image-error', id: image.id, error: (error as Error).message })
      }
      // Lets a cancel message arrive between images.
      await new Promise((resolve) => setImmediate(resolve))
    }
    port.postMessage({ type: 'complete', cancelled })
  } finally {
    await session.release()
  }
}

run().catch((error: Error) => port.postMessage({ type: 'error', error: error.message }))
