import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface ModelFile {
  name: string
  size: number
  sha256: string
}

export interface ModelSpec {
  id: string
  baseUrl: string
  files: ModelFile[]
}

export const MODEL: ModelSpec = {
  id: 'wd-swinv2-v3-627aef9',
  baseUrl: 'https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/resolve/627aef95638667ddcaa3ac8ae625e88ea5b02f51',
  files: [
    { name: 'model.onnx', size: 467460978, sha256: 'e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1' },
    { name: 'selected_tags.csv', size: 308468, sha256: '298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217' }
  ]
}

export function modelSize(spec: ModelSpec = MODEL): number {
  return spec.files.reduce((sum, file) => sum + file.size, 0)
}

function isComplete(directory: string, spec: ModelSpec): boolean {
  return spec.files.every((file) => {
    try {
      return fs.statSync(path.join(directory, file.name)).size === file.size
    } catch {
      return false
    }
  })
}

/** Finds a usable copy of the model. */
export function findModel(searchRoots: string[], spec: ModelSpec = MODEL): string | null {
  for (const root of searchRoots) {
    const directory = path.join(root, spec.id)
    if (isComplete(directory, spec)) return directory
  }
  return null
}

/** Downloads the model, checking every byte count and hash. Files only take their final name once verified. */
export async function downloadModel(
  root: string,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
  spec: ModelSpec = MODEL,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const directory = path.join(root, spec.id)
  await fs.promises.mkdir(directory, { recursive: true })
  const total = modelSize(spec)
  let completed = 0
  for (const file of spec.files) {
    const destination = path.join(directory, file.name)
    const temporary = `${destination}.part`
    const response = await fetcher(`${spec.baseUrl}/${file.name}`, signal ? { signal } : {})
    if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}).`)
    const hash = crypto.createHash('sha256')
    let count = 0
    let lastReport = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        count += chunk.length
        if (count > file.size) {
          callback(new Error('The model download is larger than expected.'))
          return
        }
        hash.update(chunk)
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now()
          onProgress(completed + count, total)
        }
        callback(null, chunk)
      }
    })
    try {
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, fs.createWriteStream(temporary))
      if (count !== file.size || hash.digest('hex') !== file.sha256) throw new Error('The model failed verification. Please download it again.')
      await fs.promises.rename(temporary, destination)
    } catch (error) {
      await fs.promises.rm(temporary, { force: true })
      throw error
    }
    completed += file.size
    onProgress(completed, total)
  }
  return directory
}
