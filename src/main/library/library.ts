import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FolderInfo, ImagePage, ImageQuery, RootInfo, Settings, UntrackedFolder } from '../../shared/api'

const SCHEMA = `
CREATE TABLE roots (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  available INTEGER NOT NULL DEFAULT 1,
  last_scan_at INTEGER
);
CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0,
  seen_scan INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  cover_id INTEGER,
  cover_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX folders_parent ON folders(parent_id, sort_key);
CREATE INDEX folders_root ON folders(root_id);
CREATE TABLE images (
  id INTEGER PRIMARY KEY,
  root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  hash TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  seen_scan INTEGER NOT NULL DEFAULT 0,
  created_scan INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX images_location ON images(folder_id, name_key);
CREATE INDEX images_name ON images(folder_id, missing, sort_key);
CREATE INDEX images_mtime ON images(folder_id, missing, mtime_ms);
CREATE INDEX images_size ON images(folder_id, missing, size);
CREATE INDEX images_file ON images(file_id);
CREATE INDEX images_root ON images(root_id, missing);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const REVIEW_SCHEMA = `
CREATE TABLE reviews (
  image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  candidates TEXT NOT NULL,
  error TEXT,
  draft TEXT,
  generated_at INTEGER NOT NULL
);
CREATE TABLE scan_state (
  image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE character_names (key TEXT PRIMARY KEY, raw TEXT NOT NULL, name TEXT NOT NULL, series TEXT);
CREATE TABLE discord_queue (
  image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  characters TEXT NOT NULL,
  set_name TEXT,
  queued_at INTEGER NOT NULL,
  last_error TEXT
);
`

const DISCORD_SCHEMA = `
CREATE TABLE discord_links (
  kind TEXT NOT NULL,
  name_key TEXT NOT NULL,
  name TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  thread_name TEXT,
  PRIMARY KEY (kind, name_key)
);
CREATE TABLE discord_uploads (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  image_id INTEGER,
  name TEXT NOT NULL,
  target_name TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  UNIQUE (hash, thread_id)
);
CREATE INDEX discord_uploads_time ON discord_uploads(posted_at);
`

const UNTRACKED_SCHEMA = `
CREATE TABLE untracked_folders (
  path_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE
);
`

const ORGANIZE_SCHEMA = `
ALTER TABLE folders ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
CREATE TABLE image_tags (
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  PRIMARY KEY (image_id, tag_key)
);
CREATE INDEX image_tags_key ON image_tags(tag_key);
`

const REMOTE_SCHEMA = `
ALTER TABLE images ADD COLUMN pixel_hash TEXT;
CREATE TABLE discord_attachments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  name TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  pixel_hash TEXT,
  posted_at INTEGER NOT NULL
);
CREATE INDEX discord_attachments_thread ON discord_attachments(thread_id, width, height);
`

const CATALOGUE_SCHEMA = `
CREATE TABLE catalogues (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE catalogue_images (
  catalogue_id INTEGER NOT NULL REFERENCES catalogues(id) ON DELETE CASCADE,
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (catalogue_id, image_id)
);
CREATE INDEX catalogue_images_order ON catalogue_images(catalogue_id, position);
`

const LEARNING_SCHEMA = `
CREATE TABLE auto_approvals (
  id INTEGER PRIMARY KEY,
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  character TEXT NOT NULL,
  undo TEXT NOT NULL,
  approved_at INTEGER NOT NULL
);
CREATE TABLE character_corrections (
  suggested_key TEXT NOT NULL,
  suggested TEXT NOT NULL,
  chosen_key TEXT NOT NULL,
  chosen TEXT NOT NULL,
  times INTEGER NOT NULL,
  PRIMARY KEY (suggested_key, chosen_key)
);
CREATE TABLE set_sources (
  folder_key TEXT NOT NULL,
  set_key TEXT NOT NULL,
  set_name TEXT NOT NULL,
  times INTEGER NOT NULL,
  PRIMARY KEY (folder_key, set_key)
);
ALTER TABLE catalogues ADD COLUMN cover_image_id INTEGER;
`

const MIGRATIONS = [SCHEMA, REVIEW_SCHEMA, DISCORD_SCHEMA, UNTRACKED_SCHEMA, ORGANIZE_SCHEMA, REMOTE_SCHEMA, CATALOGUE_SCHEMA, LEARNING_SCHEMA]
const BACKUPS_KEPT = 5

const MAX_TAG_LENGTH = 80
export const DEFAULT_QUEUE_LIMIT = 200
export const MAX_QUEUE_LIMIT = 500

export function pathKey(value: string): string {
  return path.resolve(value).toLowerCase()
}

/** Sort key that keeps "Image 2" before "Image 10". */
export function naturalKey(name: string): string {
  return name.toLowerCase().replace(/\d+/g, (digits) => digits.padStart(12, '0'))
}

/** Key range covering everything below a folder. "]" is the character right after "\". */
export function subtreeBounds(key: string): [string, string] {
  const prefix = key.replace(/\\+$/, '')
  return [`${prefix}\\`, `${prefix}]`]
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

interface FolderRow {
  id: number
  root_id: number
  parent_id: number | null
  name: string
  path: string
  image_count: number
  total_count: number
  cover_id: number | null
  cover_version: number
  has_children: number
  available: number
  favorite: number
}

const FOLDER_COLUMNS = `
  f.id, f.root_id, f.parent_id, f.name, f.path, f.image_count, f.total_count, f.cover_id, f.cover_version, f.favorite,
  EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = f.id AND c.missing = 0) AS has_children,
  (SELECT r.available FROM roots r WHERE r.id = f.root_id) AS available`

function toFolder(row: FolderRow): FolderInfo {
  return {
    id: row.id,
    rootId: row.root_id,
    parentId: row.parent_id,
    name: row.name,
    path: row.path,
    imageCount: row.image_count,
    totalCount: row.total_count,
    coverId: row.cover_id,
    coverVersion: row.cover_version,
    hasChildren: Boolean(row.has_children),
    available: Boolean(row.available),
    favorite: Boolean(row.favorite)
  }
}

export type LibraryDefaults = Pick<Settings, 'autoApprove' | 'charactersRoot' | 'setsRoot'>

export class Library {
  readonly db: DatabaseSync
  private inTransaction = false
  /** Something that went wrong while opening, for the log. */
  startupProblem: string | null = null

  constructor(file: string, private readonly defaults: LibraryDefaults) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version > MIGRATIONS.length) {
      this.db.close()
      throw new Error('This library was last used by a newer version of Thumb Grove. Install that version or newer to open it.')
    }
    if (version > 0 && version < MIGRATIONS.length) this.backUp(file, version)
    MIGRATIONS.forEach((migration, index) => {
      if (version > index) return
      this.transaction(() => {
        this.db.exec(migration)
        this.db.exec(`PRAGMA user_version = ${index + 1}`)
      })
    })
  }

  close(): void {
    this.db.close()
  }

  /** Upgrades only go forward, so a copy from before one is the way back from a bad update. */
  private backUp(file: string, version: number): void {
    try {
      const folder = path.join(path.dirname(file), 'backups')
      fs.mkdirSync(folder, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      this.db.exec(`VACUUM INTO '${path.join(folder, `library-v${version}-${stamp}.db`).replaceAll("'", "''")}'`)
      const copies = fs.readdirSync(folder).filter((name) => name.endsWith('.db')).sort()
      for (const old of copies.slice(0, Math.max(0, copies.length - BACKUPS_KEPT))) fs.rmSync(path.join(folder, old))
    } catch (error) {
      this.startupProblem = `Could not back up the library before upgrading: ${(error as Error).message}`
    }
  }

  /** Runs work atomically. Nested calls join the transaction already open. */
  transaction<T>(work: () => T): T {
    if (this.inTransaction) return work()
    this.db.exec('BEGIN')
    this.inTransaction = true
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  getValue(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setValue(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  setFolderFavorite(id: number, on: boolean): void {
    this.db.prepare('UPDATE folders SET favorite = ? WHERE id = ?').run(on ? 1 : 0, id)
  }

  getFavorites(): FolderInfo[] {
    const rows = this.db
      .prepare(`SELECT ${FOLDER_COLUMNS} FROM folders f WHERE f.favorite = 1 AND f.missing = 0 ORDER BY f.sort_key`)
      .all() as unknown as FolderRow[]
    return rows.map(toFolder)
  }

  getImageTags(id: number): string[] {
    const rows = this.db.prepare('SELECT tag FROM image_tags WHERE image_id = ? ORDER BY tag_key').all(id) as Array<{ tag: string }>
    return rows.map((row) => row.tag)
  }

  getAllTags(): string[] {
    const rows = this.db
      .prepare(
        `SELECT MIN(t.tag) AS tag FROM image_tags t JOIN images i ON i.id = t.image_id
         WHERE i.missing = 0 GROUP BY t.tag_key ORDER BY t.tag_key`
      )
      .all() as Array<{ tag: string }>
    return rows.map((row) => row.tag)
  }

  /** Adds tags to images. Returns how many were new. */
  addImageTags(ids: number[], tags: string[]): number {
    const unique = new Map<string, string>()
    for (const raw of tags) {
      const tag = raw.trim()
      if (tag && tag.length <= MAX_TAG_LENGTH && !unique.has(tag.toLowerCase())) unique.set(tag.toLowerCase(), tag)
    }
    const clean = [...unique.values()]
    let added = 0
    this.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO image_tags (image_id, tag, tag_key) VALUES (?, ?, ?)')
      for (const id of ids) for (const tag of clean) added += Number(insert.run(id, tag, tag.toLowerCase()).changes)
    })
    return added
  }

  removeImageTags(id: number, tags: string[]): void {
    const remove = this.db.prepare('DELETE FROM image_tags WHERE image_id = ? AND tag_key = ?')
    for (const tag of tags) remove.run(id, tag.toLowerCase())
  }

  setImageTags(id: number, tags: string[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(id)
      this.addImageTags([id], tags)
    })
  }

  allImageIds(): number[] {
    return (this.db.prepare('SELECT id FROM images WHERE missing = 0').all() as Array<{ id: number }>).map((row) => row.id)
  }

  /** Every available image in a folder and the folders below it. */
  imageIdsInFolder(id: number): number[] {
    const folder = this.db.prepare('SELECT path_key FROM folders WHERE id = ?').get(id) as { path_key: string } | undefined
    if (!folder) return []
    const [low, high] = subtreeBounds(folder.path_key)
    const rows = this.db
      .prepare(
        `SELECT i.id FROM images i WHERE i.missing = 0 AND i.folder_id IN
         (SELECT id FROM folders WHERE path_key = ? OR (path_key >= ? AND path_key < ?))`
      )
      .all(folder.path_key, low, high) as Array<{ id: number }>
    return rows.map((row) => row.id)
  }

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    const saved = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const flag = (key: string, fallback: boolean): boolean => (saved[key] === undefined ? fallback : saved[key] === 'true')
    const number = (key: string, fallback: number): number => (saved[key] === undefined ? fallback : Number(saved[key]))
    return {
      queueLimit: number('queueLimit', DEFAULT_QUEUE_LIMIT),
      autoApprove: flag('autoApprove', this.defaults.autoApprove),
      autoApproveThreshold: number('autoApproveThreshold', 0.9),
      preselectThreshold: number('preselectThreshold', 0.75),
      charactersRoot: saved.charactersRoot ?? this.defaults.charactersRoot,
      setsRoot: saved.setsRoot ?? this.defaults.setsRoot,
      autoScanEnabled: flag('autoScanEnabled', false),
      autoScanFolder: saved.autoScanFolder ?? '',
      autoScanSubfolders: flag('autoScanSubfolders', false),
      defaultPlaceInCharacters: flag('defaultPlaceInCharacters', true),
      defaultPlaceInSet: flag('defaultPlaceInSet', true),
      carrySet: flag('carrySet', false),
      tileSize: number('tileSize', 172),
      uploadLimitMb: number('uploadLimitMb', 0),
      checkBeforeUpload: flag('checkBeforeUpload', true),
      learnCorrections: flag('learnCorrections', true)
    }
  }

  /** Finds folders by name or path, for choosing a destination. Favorites come first. */
  searchFolders(query: string, limit = 50): FolderInfo[] {
    const pattern = `%${escapeLike(query.trim().toLowerCase())}%`
    const rows = this.db
      .prepare(
        `SELECT ${FOLDER_COLUMNS} FROM folders f
         WHERE f.missing = 0 AND f.path_key LIKE ? ESCAPE '\\'
         ORDER BY f.favorite DESC, length(f.path_key), f.path_key LIMIT ?`
      )
      .all(pattern, limit) as unknown as FolderRow[]
    return rows.map(toFolder)
  }

  setSetting(key: keyof Settings, value: string | boolean | number): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  }

  addRoot(chosen: string): RootInfo {
    const real = fs.realpathSync.native(chosen)
    if (!fs.statSync(real).isDirectory()) throw new Error('Choose a folder to watch.')
    const key = pathKey(real)
    for (const root of this.db.prepare('SELECT path, path_key FROM roots').all() as Array<{ path: string; path_key: string }>) {
      if (root.path_key === key) throw new Error('This folder is already being watched.')
      if (key.startsWith(`${root.path_key}\\`)) throw new Error(`This folder is already inside ${root.path}.`)
      if (root.path_key.startsWith(`${key}\\`)) throw new Error(`This folder contains ${root.path}, which is already being watched. Stop watching that one first.`)
    }
    const name = path.basename(real) || real
    const id = this.transaction(() => {
      const rootId = Number(this.db.prepare('INSERT INTO roots (path, path_key) VALUES (?, ?)').run(real, key).lastInsertRowid)
      this.db
        .prepare('INSERT INTO folders (root_id, path, path_key, name, sort_key) VALUES (?, ?, ?, ?, ?)')
        .run(rootId, real, key, name, naturalKey(name))
      return rootId
    })
    return this.getRoot(id)!
  }

  /** Forgets a folder. Only the index changes. Files on disk are never touched. */
  removeRoot(id: number): void {
    this.db.prepare('DELETE FROM roots WHERE id = ?').run(id)
  }

  getRoots(): RootInfo[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.path, r.available, r.last_scan_at, f.id AS folder_id, f.name, f.total_count
         FROM roots r JOIN folders f ON f.path_key = r.path_key
         ORDER BY f.sort_key`
      )
      .all() as Array<{ id: number; path: string; available: number; last_scan_at: number | null; folder_id: number; name: string; total_count: number }>
    return rows.map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      name: r.name,
      path: r.path,
      available: Boolean(r.available),
      imageCount: r.total_count,
      lastScanAt: r.last_scan_at
    }))
  }

  getRoot(id: number): RootInfo | null {
    return this.getRoots().find((root) => root.id === id) ?? null
  }

  getChildren(parentId: number | null): FolderInfo[] {
    const rows = this.db
      .prepare(`SELECT ${FOLDER_COLUMNS} FROM folders f WHERE f.parent_id IS ? AND f.missing = 0 ORDER BY f.favorite DESC, f.sort_key`)
      .all(parentId) as unknown as FolderRow[]
    return rows.map(toFolder)
  }

  getFolder(id: number): FolderInfo | null {
    const row = this.db.prepare(`SELECT ${FOLDER_COLUMNS} FROM folders f WHERE f.id = ? AND f.missing = 0`).get(id) as FolderRow | undefined
    return row ? toFolder(row) : null
  }

  getFolderByPath(value: string): FolderInfo | null {
    const row = this.db
      .prepare(`SELECT ${FOLDER_COLUMNS} FROM folders f WHERE f.path_key = ? AND f.missing = 0`)
      .get(pathKey(value)) as FolderRow | undefined
    return row ? toFolder(row) : null
  }

  /** The folder and its parents, starting from the watched folder. */
  getAncestors(id: number): FolderInfo[] {
    const chain: FolderInfo[] = []
    let current = this.getFolder(id)
    while (current) {
      chain.unshift(current)
      current = current.parentId === null ? null : this.getFolder(current.parentId)
    }
    return chain
  }

  listImages(query: ImageQuery): ImagePage {
    const search = query.search.trim().toLowerCase()
    const clauses = ['i.missing = 0']
    const params: Array<string | number> = []

    if (query.folderId !== null) {
      if (search || query.includeSubfolders) {
        const folder = this.db.prepare('SELECT path_key FROM folders WHERE id = ?').get(query.folderId) as { path_key: string } | undefined
        if (!folder) return { total: 0, items: [] }
        const [low, high] = subtreeBounds(folder.path_key)
        clauses.push('i.folder_id IN (SELECT id FROM folders WHERE path_key = ? OR (path_key >= ? AND path_key < ?))')
        params.push(folder.path_key, low, high)
      } else {
        clauses.push('i.folder_id = ?')
        params.push(query.folderId)
      }
    }
    if (search) {
      // Finds images by filename, by tag, or by the name of the folder they're in.
      clauses.push(`(
        i.name_key LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM image_tags t WHERE t.image_id = i.id AND t.tag_key LIKE ? ESCAPE '\\')
        OR i.folder_id IN (SELECT id FROM folders WHERE name LIKE ? ESCAPE '\\')
      )`)
      const pattern = `%${escapeLike(search)}%`
      params.push(pattern, pattern, pattern)
    }

    const where = clauses.join(' AND ')
    const order = {
      name: 'i.sort_key',
      newest: 'i.mtime_ms DESC, i.sort_key',
      oldest: 'i.mtime_ms, i.sort_key',
      largest: 'i.size DESC, i.sort_key'
    }[query.sort]
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM images i WHERE ${where}`).get(...params) as { total: number }
    const rows = this.db
      .prepare(`SELECT i.id, i.folder_id, i.name, i.size, i.mtime_ms FROM images i WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset) as Array<{ id: number; folder_id: number; name: string; size: number; mtime_ms: number }>
    return {
      total,
      items: rows.map((r) => ({ id: r.id, folderId: r.folder_id, name: r.name, size: r.size, mtimeMs: r.mtime_ms }))
    }
  }

  getUntracked(): UntrackedFolder[] {
    const rows = this.db.prepare('SELECT path, root_id FROM untracked_folders ORDER BY path_key').all() as Array<{ path: string; root_id: number }>
    return rows.map((row) => ({ path: row.path, rootId: row.root_id }))
  }

  /** True for an untracked folder and anything inside it. */
  isUntracked(folder: string): boolean {
    const key = pathKey(folder)
    return this.getUntracked().some(({ path: untracked }) => {
      const other = pathKey(untracked)
      return key === other || key.startsWith(`${other}\\`)
    })
  }

  /** Stops indexing a folder and everything in it. Only the index changes, never the files. */
  untrackFolder(id: number): void {
    const folder = this.getFolder(id)
    if (!folder) throw new Error('This folder is no longer available.')
    if (folder.parentId === null) throw new Error('Use Stop watching for a watched folder.')
    this.transaction(() => {
      const [low, high] = subtreeBounds(pathKey(folder.path))
      this.db.prepare('DELETE FROM untracked_folders WHERE path_key >= ? AND path_key < ?').run(low, high)
      this.db.prepare('INSERT OR REPLACE INTO untracked_folders (path_key, path, root_id) VALUES (?, ?, ?)').run(pathKey(folder.path), folder.path, folder.rootId)
      this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
    })
  }

  retrackFolder(folder: string): { rootId: number } | null {
    const key = pathKey(folder)
    const row = this.db.prepare('SELECT root_id FROM untracked_folders WHERE path_key = ?').get(key) as { root_id: number } | undefined
    if (!row) return null
    this.db.prepare('DELETE FROM untracked_folders WHERE path_key = ?').run(key)
    return { rootId: row.root_id }
  }

  /**
   * Records a folder's new location after it moved on disk. Folder and image ids stay the same, so
   * reviews, the Discord queue, and open views all keep working.
   */
  relocateFolder(id: number, destination: string, parentId: number, rootId: number): void {
    const current = this.db.prepare('SELECT path, path_key FROM folders WHERE id = ?').get(id) as { path: string; path_key: string } | undefined
    if (!current) throw new Error('This folder is no longer available.')
    const [low, high] = subtreeBounds(current.path_key)
    const name = path.basename(destination)
    const moved = (value: string): string => `${destination}${value.slice(current.path.length)}`
    this.transaction(() => {
      const rows = this.db
        .prepare('SELECT id, path FROM folders WHERE path_key = ? OR (path_key >= ? AND path_key < ?)')
        .all(current.path_key, low, high) as Array<{ id: number; path: string }>
      const ids = new Set(rows.map((row) => row.id))
      // Leftover records of a deleted folder at the destination would block the new location.
      const [newLow, newHigh] = subtreeBounds(pathKey(destination))
      const stale = this.db
        .prepare('SELECT id FROM folders WHERE missing = 1 AND (path_key = ? OR (path_key >= ? AND path_key < ?))')
        .all(pathKey(destination), newLow, newHigh) as Array<{ id: number }>
      for (const row of stale) if (!ids.has(row.id)) this.db.prepare('DELETE FROM folders WHERE id = ?').run(row.id)

      const update = this.db.prepare('UPDATE folders SET path = ?, path_key = ?, root_id = ? WHERE id = ?')
      const updateImages = this.db.prepare('UPDATE images SET root_id = ? WHERE folder_id = ?')
      for (const row of rows) {
        const next = moved(row.path)
        update.run(next, pathKey(next), rootId, row.id)
        updateImages.run(rootId, row.id)
      }
      this.db.prepare('UPDATE folders SET name = ?, sort_key = ?, parent_id = ? WHERE id = ?').run(name, naturalKey(name), parentId, id)

      // Untracked folders inside stay untracked at their new location.
      const untracked = this.db.prepare('SELECT path, path_key FROM untracked_folders WHERE path_key >= ? AND path_key < ?').all(low, high) as Array<{ path: string; path_key: string }>
      for (const row of untracked) {
        const next = moved(row.path)
        this.db.prepare('UPDATE untracked_folders SET path = ?, path_key = ?, root_id = ? WHERE path_key = ?').run(next, pathKey(next), rootId, row.path_key)
      }
    })
  }

  imageIdAtPath(file: string): number | null {
    const dir = pathKey(path.dirname(file))
    const row = this.db
      .prepare('SELECT i.id FROM images i JOIN folders f ON f.id = i.folder_id WHERE f.path_key = ? AND i.name_key = ? AND i.missing = 0')
      .get(dir, path.basename(file).toLowerCase()) as { id: number } | undefined
    return row?.id ?? null
  }

  /** Full path of an indexed image. Only paths known to the index can ever be served to the interface. */
  imageFile(id: number): { path: string; mtimeMs: number } | null {
    const row = this.db
      .prepare('SELECT f.path AS dir, i.name, i.mtime_ms FROM images i JOIN folders f ON f.id = i.folder_id WHERE i.id = ? AND i.missing = 0')
      .get(id) as { dir: string; name: string; mtime_ms: number } | undefined
    return row ? { path: path.join(row.dir, row.name), mtimeMs: row.mtime_ms } : null
  }
}
