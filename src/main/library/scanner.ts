import fsp from 'node:fs/promises'
import path from 'node:path'
import { naturalKey, pathKey, subtreeBounds, type Library } from './library'

export const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
export const MAX_IMAGE_BYTES = 200 * 1024 * 1024
export const MAX_ROOT_IMAGES = 100_000

const SKIPPED_FOLDERS = new Set(['$recycle.bin', 'system volume information', 'node_modules'])
const STAT_BATCH = 64
const PROGRESS_INTERVAL_MS = 200
const RECOUNT_INTERVAL_MS = 3000

export interface ScanTarget {
  path: string
  /** False checks only the images directly in this folder. */
  recursive: boolean
}

export interface ScanOptions {
  maxImages?: number
  maxBytes?: number
  onProgress?(filesSeen: number): void
  onPartial?(): void
}

export interface ScanResult {
  available: boolean
  filesSeen: number
  /** Stopped at the image limit, so anything not reached is left alone. */
  limited: boolean
  unreadable: string[]
}

interface FoundFile {
  name: string
  size: number
  mtimeMs: number
  fileId: string
}

interface ExistingImage {
  id: number
  name: string
  size: number
  mtime_ms: number
  file_id: string
}

export function isSkippedFolder(name: string): boolean {
  return name.startsWith('.') || SKIPPED_FOLDERS.has(name.toLowerCase())
}

async function statFiles(dir: string, names: string[], maxBytes: number): Promise<{ found: FoundFile[]; unreadable: string[] }> {
  const found: FoundFile[] = []
  const unreadable: string[] = []
  for (let start = 0; start < names.length; start += STAT_BATCH) {
    const batch = names.slice(start, start + STAT_BATCH)
    await Promise.all(
      batch.map(async (name) => {
        try {
          const stat = await fsp.stat(path.join(dir, name), { bigint: true })
          if (!stat.isFile() || stat.size > BigInt(maxBytes)) return
          found.push({ name, size: Number(stat.size), mtimeMs: Math.trunc(Number(stat.mtimeMs)), fileId: stat.ino.toString() })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(name)
        }
      })
    )
  }
  return { found, unreadable }
}

/** Adds the folder and any parents missing from the index, and returns its id. */
function ensureFolder(library: Library, rootId: number, rootPath: string, dir: string, scan: number): number {
  const { db } = library
  const key = pathKey(dir)
  const existing = db.prepare('SELECT id FROM folders WHERE path_key = ?').get(key) as { id: number } | undefined
  if (existing) {
    db.prepare('UPDATE folders SET missing = 0, seen_scan = ?, path = ? WHERE id = ?').run(scan, dir, existing.id)
    return existing.id
  }
  if (pathKey(rootPath) === key) throw new Error('The watched folder is missing from the index.')
  const parentId = ensureFolder(library, rootId, rootPath, path.dirname(dir), scan)
  const name = path.basename(dir)
  return Number(
    db
      .prepare('INSERT INTO folders (root_id, parent_id, path, path_key, name, sort_key, seen_scan) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(rootId, parentId, dir, key, name, naturalKey(name), scan).lastInsertRowid
  )
}

function storeFolderContents(
  library: Library,
  rootId: number,
  folderId: number,
  files: FoundFile[],
  unreadableNames: string[],
  scan: number
): void {
  const { db } = library
  const rows = db.prepare('SELECT id, name, size, mtime_ms, file_id FROM images WHERE folder_id = ?').all(folderId) as unknown as ExistingImage[]
  const existing = new Map(rows.map((row) => [row.name.toLowerCase(), row]))
  const insert = db.prepare(
    `INSERT INTO images (root_id, folder_id, name, name_key, sort_key, size, mtime_ms, file_id, seen_scan, created_scan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const touch = db.prepare('UPDATE images SET seen_scan = ?, missing = 0 WHERE id = ?')
  const update = db.prepare(
    `UPDATE images SET name = ?, sort_key = ?, size = ?, mtime_ms = ?, file_id = ?, hash = NULL, pixel_hash = NULL, seen_scan = ?, missing = 0 WHERE id = ?`
  )
  for (const file of files) {
    const key = file.name.toLowerCase()
    const row = existing.get(key)
    if (!row) {
      insert.run(rootId, folderId, file.name, key, naturalKey(file.name), file.size, file.mtimeMs, file.fileId, scan, scan)
    } else if (row.name === file.name && row.size === file.size && row.mtime_ms === file.mtimeMs && row.file_id === file.fileId) {
      touch.run(scan, row.id)
    } else {
      update.run(file.name, naturalKey(file.name), file.size, file.mtimeMs, file.fileId, scan, row.id)
    }
  }
  // A file that exists but couldn't be read right now hasn't gone anywhere.
  for (const name of unreadableNames) {
    const row = existing.get(name.toLowerCase())
    if (row) db.prepare('UPDATE images SET seen_scan = ? WHERE id = ?').run(scan, row.id)
  }
}

/** Marks what wasn't found as missing, leaving alone anything that couldn't be checked. */
function markMissing(library: Library, targets: ScanTarget[], unreadableDirs: string[], scan: number): void {
  const { db } = library
  for (const dir of unreadableDirs) {
    const key = pathKey(dir)
    const [low, high] = subtreeBounds(key)
    const inside = 'SELECT id FROM folders WHERE path_key = ? OR (path_key >= ? AND path_key < ?)'
    db.prepare(`UPDATE images SET seen_scan = ? WHERE folder_id IN (${inside})`).run(scan, key, low, high)
    db.prepare(`UPDATE folders SET seen_scan = ? WHERE id IN (${inside})`).run(scan, key, low, high)
  }
  for (const target of targets) {
    const key = pathKey(target.path)
    if (target.recursive) {
      const [low, high] = subtreeBounds(key)
      const inside = 'SELECT id FROM folders WHERE path_key = ? OR (path_key >= ? AND path_key < ?)'
      db.prepare(`UPDATE images SET missing = 1 WHERE missing = 0 AND seen_scan <> ? AND folder_id IN (${inside})`).run(scan, key, low, high)
      db.prepare('UPDATE folders SET missing = 1 WHERE missing = 0 AND seen_scan <> ? AND parent_id IS NOT NULL AND (path_key = ? OR (path_key >= ? AND path_key < ?))').run(scan, key, low, high)
    } else {
      db.prepare('UPDATE images SET missing = 1 WHERE missing = 0 AND seen_scan <> ? AND folder_id IN (SELECT id FROM folders WHERE path_key = ?)').run(scan, key)
    }
  }
}

/** A new image with the same disk identity as a missing one is the same file, moved or renamed. It keeps its id. */
function relinkMoved(library: Library, scan: number): void {
  const { db } = library
  const pairs = db
    .prepare(
      `SELECT n.id AS new_id, o.id AS old_id, n.root_id, n.folder_id, n.name, n.name_key, n.sort_key, n.mtime_ms
       FROM images n JOIN images o ON o.file_id = n.file_id AND o.size = n.size AND o.missing = 1 AND o.id <> n.id
       WHERE n.created_scan = ? AND n.missing = 0`
    )
    .all(scan) as Array<{ new_id: number; old_id: number; root_id: number; folder_id: number; name: string; name_key: string; sort_key: string; mtime_ms: number }>
  const used = new Set<number>()
  for (const pair of pairs) {
    if (used.has(pair.old_id) || used.has(pair.new_id)) continue
    used.add(pair.old_id)
    used.add(pair.new_id)
    db.prepare('DELETE FROM images WHERE id = ?').run(pair.new_id)
    db.prepare(
      `UPDATE images SET root_id = ?, folder_id = ?, name = ?, name_key = ?, sort_key = ?, mtime_ms = ?, seen_scan = ?, missing = 0 WHERE id = ?`
    ).run(pair.root_id, pair.folder_id, pair.name, pair.name_key, pair.sort_key, pair.mtime_ms, scan, pair.old_id)
  }
}

/** Recalculates each folder's image counts and cover from the images in it and below it. */
export function recount(library: Library, rootId: number): void {
  const { db } = library
  const folders = db
    .prepare('SELECT id, parent_id, path_key, image_count, total_count, cover_id, cover_version FROM folders WHERE root_id = ? AND missing = 0')
    .all(rootId) as Array<{ id: number; parent_id: number | null; path_key: string; image_count: number; total_count: number; cover_id: number | null; cover_version: number }>
  const direct = new Map(
    (
      db
        .prepare('SELECT folder_id, COUNT(*) AS n, id, mtime_ms, MIN(sort_key) FROM images WHERE root_id = ? AND missing = 0 GROUP BY folder_id')
        .all(rootId) as Array<{ folder_id: number; n: number; id: number; mtime_ms: number }>
    ).map((row) => [row.folder_id, row])
  )
  const totals = new Map<number, { total: number; coverId: number | null; coverVersion: number }>()
  const deepestFirst = [...folders].sort((a, b) => b.path_key.length - a.path_key.length)
  for (const folder of deepestFirst) {
    const own = direct.get(folder.id)
    const entry = totals.get(folder.id) ?? { total: 0, coverId: null, coverVersion: 0 }
    entry.total += own?.n ?? 0
    if (own) {
      entry.coverId = own.id
      entry.coverVersion = own.mtime_ms
    }
    totals.set(folder.id, entry)
    if (folder.parent_id !== null) {
      const parent = totals.get(folder.parent_id) ?? { total: 0, coverId: null, coverVersion: 0 }
      parent.total += entry.total
      if (parent.coverId === null && entry.coverId !== null) {
        parent.coverId = entry.coverId
        parent.coverVersion = entry.coverVersion
      }
      totals.set(folder.parent_id, parent)
    }
  }
  const write = db.prepare('UPDATE folders SET image_count = ?, total_count = ?, cover_id = ?, cover_version = ? WHERE id = ?')
  library.transaction(() => {
    for (const folder of folders) {
      const entry = totals.get(folder.id)!
      const count = direct.get(folder.id)?.n ?? 0
      const changed =
        folder.image_count !== count ||
        folder.total_count !== entry.total ||
        folder.cover_id !== entry.coverId ||
        folder.cover_version !== entry.coverVersion
      if (changed) write.run(count, entry.total, entry.coverId, entry.coverVersion, folder.id)
    }
  })
}

/**
 * Brings the index up to date with the disk for part or all of a watched folder.
 *
 * Nothing here writes to the watched folders. If the folder is unavailable, for example because a
 * drive is disconnected, the index is kept as it is so that images aren't lost from it.
 */
export async function scanRoot(library: Library, rootId: number, targets: ScanTarget[] | null, options: ScanOptions = {}): Promise<ScanResult> {
  const { db } = library
  const maxImages = options.maxImages ?? MAX_ROOT_IMAGES
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  const root = db.prepare('SELECT path FROM roots WHERE id = ?').get(rootId) as { path: string } | undefined
  if (!root) return { available: false, filesSeen: 0, limited: false, unreadable: [] }

  const rootAvailable = await fsp.stat(root.path).then((s) => s.isDirectory(), () => false)
  db.prepare('UPDATE roots SET available = ? WHERE id = ?').run(rootAvailable ? 1 : 0, rootId)
  if (!rootAvailable) return { available: false, filesSeen: 0, limited: false, unreadable: [] }

  const { scan } = db.prepare('SELECT COALESCE(MAX(seen_scan), 0) + 1 AS scan FROM folders').get() as { scan: number }
  const work = targets ?? [{ path: root.path, recursive: true }]
  const unreadable: string[] = []
  let filesSeen = 0
  let limited = false
  let lastProgress = 0
  let lastRecount = Date.now()

  // A partial scan still has to respect the limit, counting what is already indexed elsewhere.
  if (targets) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM images WHERE root_id = ? AND missing = 0').get(rootId) as { n: number }
    if (n >= maxImages) limited = true
  }

  const untracked = new Set(library.getUntracked().map((folder) => pathKey(folder.path)))
  const scannable = work.filter((target) => !library.isUntracked(target.path))

  for (const target of scannable) {
    const stack = [target.path]
    while (stack.length && !limited) {
      const dir = stack.pop()!
      let names: string[] = []
      try {
        const handle = await fsp.opendir(dir)
        for await (const entry of handle) {
          if (entry.isDirectory()) {
            const child = path.join(dir, entry.name)
            if (target.recursive && !isSkippedFolder(entry.name) && !untracked.has(pathKey(child))) stack.push(child)
          } else if ((entry.isFile() || entry.isSymbolicLink()) && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            names.push(entry.name)
          }
        }
      } catch (error) {
        // A folder that's gone is picked up as missing below. Any other failure means it couldn't be checked.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') unreadable.push(dir)
        continue
      }
      if (filesSeen + names.length > maxImages) {
        names = names.slice(0, maxImages - filesSeen)
        limited = true
      }
      const { found, unreadable: unreadableFiles } = await statFiles(dir, names, maxBytes)
      filesSeen += found.length
      library.transaction(() => {
        const folderId = ensureFolder(library, rootId, root.path, dir, scan)
        storeFolderContents(library, rootId, folderId, found, unreadableFiles, scan)
      })
      const now = Date.now()
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now
        options.onProgress?.(filesSeen)
      }
      if (options.onPartial && now - lastRecount >= RECOUNT_INTERVAL_MS) {
        lastRecount = now
        recount(library, rootId)
        options.onPartial()
      }
    }
  }

  library.transaction(() => {
    // After a stop at the limit, unreached files must not be treated as deleted.
    if (!limited) markMissing(library, scannable, unreadable, scan)
    relinkMoved(library, scan)
    db.prepare('UPDATE roots SET last_scan_at = ? WHERE id = ?').run(Date.now(), rootId)
  })
  recount(library, rootId)
  options.onProgress?.(filesSeen)
  return { available: true, filesSeen, limited, unreadable }
}
