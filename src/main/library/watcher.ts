import fs from 'node:fs'
import path from 'node:path'
import { isSkippedFolder, SUPPORTED_EXTENSIONS, type ScanTarget } from './scanner'

const DEBOUNCE_MS = 700

/** Turns changed paths into the smallest set of folders worth rescanning. */
export function targetsForChanges(rootPath: string, relativePaths: string[]): ScanTarget[] {
  const recursive = new Set<string>()
  const direct = new Set<string>()
  for (const relative of relativePaths) {
    if (relative.split(/[\\/]/).some(isSkippedFolder)) continue
    const full = path.join(rootPath, relative)
    let isDirectory = false
    try {
      isDirectory = fs.statSync(full).isDirectory()
    } catch {
      // The path is gone. It's either an image or a whole folder, and the parent scan covers both.
      const extension = path.extname(relative).toLowerCase()
      if (extension && !SUPPORTED_EXTENSIONS.has(extension)) continue
      recursive.add(path.dirname(full))
      continue
    }
    if (isDirectory) recursive.add(full)
    else if (SUPPORTED_EXTENSIONS.has(path.extname(relative).toLowerCase())) direct.add(path.dirname(full))
  }
  const covered = (dir: string): boolean =>
    [...recursive].some((other) => other !== dir && dir.toLowerCase().startsWith(`${other.toLowerCase()}\\`))
  return [
    ...[...recursive].filter((dir) => !covered(dir)).map((dir) => ({ path: dir, recursive: true })),
    ...[...direct].filter((dir) => !recursive.has(dir) && !covered(dir)).map((dir) => ({ path: dir, recursive: false }))
  ]
}

/** Watches a folder tree and reports changes in batches, because one move produces many events. */
export class RootWatcher {
  private watcher: fs.FSWatcher | null = null
  private pending = new Set<string>()
  private fullRescan = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly rootPath: string,
    private readonly onChange: (targets: ScanTarget[] | null) => void,
    private readonly onFailure: () => void
  ) {}

  start(): void {
    try {
      this.watcher = fs.watch(this.rootPath, { recursive: true }, (_event, file) => {
        if (file) this.pending.add(file.toString())
        else this.fullRescan = true
        this.schedule()
      })
      this.watcher.on('error', () => {
        this.stop()
        this.onFailure()
      })
    } catch {
      this.onFailure()
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS)
  }

  private flush(): void {
    this.timer = null
    const changed = [...this.pending]
    this.pending.clear()
    if (this.fullRescan) {
      this.fullRescan = false
      this.onChange(null)
      return
    }
    const targets = targetsForChanges(this.rootPath, changed)
    if (targets.length) this.onChange(targets)
  }
}
