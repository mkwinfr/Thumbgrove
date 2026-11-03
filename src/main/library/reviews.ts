import type { Candidate, Correction, Draft, ReviewRecord } from '../../shared/api'
import { nameKey, type CharacterName } from '../../shared/naming'
import { DEFAULT_QUEUE_LIMIT as QUEUE_LIMIT, pathKey, subtreeBounds, type Library } from './library'

export { QUEUE_LIMIT }

/** A correction has to happen this many times before Thumb Grove acts on it. */
export const LEARN_AFTER = 2

export interface ReviewSnapshot {
  id: number
  candidates: string
  error: string | null
  draft: string | null
  generatedAt: number
}

export interface QueuedImage {
  imageId: number
  characters: string
  setName: string | null
  queuedAt: number
}

export interface EligibleImage {
  id: number
  name: string
  file: string
}

/** The review queue, scan history, saved character names, and the queue of images for Discord. */
export class ReviewStore {
  constructor(private readonly library: Library) {}

  private get db() {
    return this.library.db
  }

  pendingCount(): number {
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM reviews r JOIN images i ON i.id = r.image_id WHERE i.missing = 0')
      .get() as { n: number }
    return n
  }

  list(): ReviewRecord[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.name, f.path AS folder, i.size, i.mtime_ms, r.candidates, r.error, r.draft
         FROM reviews r JOIN images i ON i.id = r.image_id JOIN folders f ON f.id = i.folder_id
         WHERE i.missing = 0
         ORDER BY r.generated_at, i.sort_key`
      )
      .all() as Array<{ id: number; name: string; folder: string; size: number; mtime_ms: number; candidates: string; error: string | null; draft: string | null }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      folder: row.folder,
      size: row.size,
      mtimeMs: row.mtime_ms,
      candidates: JSON.parse(row.candidates) as Candidate[],
      error: row.error,
      draft: row.draft ? (JSON.parse(row.draft) as Draft) : null,
      suggestedSet: null
    }))
  }

  /** Records that a suggested character was replaced, or forgets that it was once it's accepted. */
  learnFromChoice(candidates: Candidate[], chosen: string[]): void {
    if (!chosen.length) return
    const chosenKeys = new Set(chosen.map(nameKey))
    const offered = new Set(candidates.map((c) => nameKey(c.learnedFrom ?? c.tag)))
    const modelTags = candidates.filter((c) => !c.filenameOnly)
    for (const candidate of modelTags) {
      if (chosenKeys.has(nameKey(candidate.tag)) && !candidate.learnedFrom) {
        this.db.prepare('DELETE FROM character_corrections WHERE suggested_key = ?').run(nameKey(candidate.tag))
      }
    }
    const top = modelTags[0]
    if (!top || chosenKeys.has(nameKey(top.tag))) return
    const suggested = top.learnedFrom ?? top.tag
    const record = this.db.prepare(
      `INSERT INTO character_corrections (suggested_key, suggested, chosen_key, chosen, times) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(suggested_key, chosen_key) DO UPDATE SET times = times + 1, chosen = excluded.chosen`
    )
    for (const raw of chosen) {
      if (!offered.has(nameKey(raw))) record.run(nameKey(suggested), suggested, nameKey(raw), raw)
    }
  }

  /** Swaps in the character you've repeatedly chosen instead of a suggestion. */
  applyCorrections(candidates: Candidate[]): Candidate[] {
    const find = this.db.prepare('SELECT chosen FROM character_corrections WHERE suggested_key = ? AND times >= ? ORDER BY times DESC LIMIT 1')
    const seen = new Set<string>()
    const result: Candidate[] = []
    for (const candidate of candidates) {
      const match = candidate.filenameOnly ? undefined : (find.get(nameKey(candidate.tag), LEARN_AFTER) as { chosen: string } | undefined)
      const next: Candidate = match ? { ...candidate, tag: match.chosen, learnedFrom: candidate.tag } : candidate
      const key = nameKey(next.tag)
      if (!seen.has(key)) {
        seen.add(key)
        result.push(next)
      }
    }
    return result
  }

  getCorrections(): Correction[] {
    const rows = this.db.prepare('SELECT suggested, chosen, times FROM character_corrections WHERE times >= ? ORDER BY times DESC, suggested').all(LEARN_AFTER)
    return rows as unknown as Correction[]
  }

  forgetCorrection(suggested: string, chosen: string): void {
    this.db.prepare('DELETE FROM character_corrections WHERE suggested_key = ? AND chosen_key = ?').run(nameKey(suggested), nameKey(chosen))
  }

  recordSetSource(folder: string, setName: string): void {
    this.db
      .prepare(
        `INSERT INTO set_sources (folder_key, set_key, set_name, times) VALUES (?, ?, ?, 1)
         ON CONFLICT(folder_key, set_key) DO UPDATE SET times = times + 1, set_name = excluded.set_name`
      )
      .run(pathKey(folder), nameKey(setName), setName)
  }

  /** The set most often applied to images from each folder. */
  setSources(): Map<string, string> {
    const rows = this.db.prepare('SELECT folder_key, set_name FROM set_sources ORDER BY times').all() as Array<{ folder_key: string; set_name: string }>
    return new Map(rows.map((row) => [row.folder_key, row.set_name]))
  }

  renameSetReferences(from: string, to: string): void {
    this.db.prepare('UPDATE discord_queue SET set_name = ? WHERE lower(set_name) = ?').run(to, from.toLowerCase())
    this.db.prepare('UPDATE OR REPLACE set_sources SET set_key = ?, set_name = ? WHERE set_key = ?').run(nameKey(to), to, nameKey(from))
    const drafts = this.db.prepare('SELECT image_id, draft FROM reviews WHERE draft IS NOT NULL').all() as Array<{ image_id: number; draft: string }>
    const save = this.db.prepare('UPDATE reviews SET draft = ? WHERE image_id = ?')
    for (const row of drafts) {
      const draft = JSON.parse(row.draft) as Draft
      if (draft.setName && nameKey(draft.setName) === nameKey(from)) save.run(JSON.stringify({ ...draft, setName: to }), row.image_id)
    }
  }

  /**
   * Picks images to scan, up to the free space in the queue. Images already scanned are left out
   * unless they changed, were cleared from the queue, or a rescan was asked for.
   */
  eligible(folderId: number, includeSubfolders: boolean, force: boolean, limit = QUEUE_LIMIT, skipCleared = false): EligibleImage[] {
    const folder = this.db.prepare('SELECT path_key FROM folders WHERE id = ?').get(folderId) as { path_key: string } | undefined
    if (!folder) return []
    const [low, high] = subtreeBounds(pathKey(folder.path_key))
    const scope = includeSubfolders
      ? 'i.folder_id IN (SELECT id FROM folders WHERE path_key = ? OR (path_key >= ? AND path_key < ?))'
      : 'i.folder_id IN (SELECT id FROM folders WHERE path_key = ?)'
    const params = includeSubfolders ? [folder.path_key, low, high] : [folder.path_key]
    const rows = this.db
      .prepare(
        `SELECT i.id, i.name, f.path AS dir, i.size, i.mtime_ms, s.size AS scanned_size, s.mtime_ms AS scanned_mtime, s.status,
           EXISTS (SELECT 1 FROM reviews r WHERE r.image_id = i.id) AS pending
         FROM images i JOIN folders f ON f.id = i.folder_id LEFT JOIN scan_state s ON s.image_id = i.id
         WHERE i.missing = 0 AND ${scope}
         ORDER BY i.sort_key`
      )
      .all(...params) as Array<{ id: number; name: string; dir: string; size: number; mtime_ms: number; scanned_size: number | null; scanned_mtime: number | null; status: string | null; pending: number }>

    let free = Math.max(0, limit - this.pendingCount())
    const result: EligibleImage[] = []
    for (const row of rows) {
      if (result.length === limit) break
      const unchanged = row.scanned_size === row.size && row.scanned_mtime === row.mtime_ms
      const dismissed = row.status === 'cleared' && !skipCleared
      if (!force && (row.pending || (row.status && !dismissed && unchanged))) continue
      if (!row.pending) {
        if (!free) continue
        free--
      }
      result.push({ id: row.id, name: row.name, file: `${row.dir}\\${row.name}` })
    }
    return result
  }

  setResult(id: number, candidates: Candidate[], error: string | null): void {
    const image = this.db.prepare('SELECT size, mtime_ms FROM images WHERE id = ? AND missing = 0').get(id) as { size: number; mtime_ms: number } | undefined
    if (!image) return
    this.library.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO reviews (image_id, candidates, error, generated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(image_id) DO UPDATE SET candidates = excluded.candidates, error = excluded.error, draft = NULL, generated_at = excluded.generated_at`
        )
        .run(id, JSON.stringify(candidates), error, Date.now())
      this.setState(id, error ? 'error' : 'scanned')
    })
  }

  setState(id: number, status: 'scanned' | 'processed' | 'error' | 'cleared'): void {
    this.db
      .prepare(
        `INSERT INTO scan_state (image_id, size, mtime_ms, status)
         SELECT id, size, mtime_ms, ? FROM images WHERE id = ?
         ON CONFLICT(image_id) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, status = excluded.status`
      )
      .run(status, id)
  }

  saveDraft(id: number, draft: Draft): void {
    this.db.prepare('UPDATE reviews SET draft = ? WHERE image_id = ?').run(JSON.stringify(draft), id)
  }

  snapshot(ids: number[]): ReviewSnapshot[] {
    const read = this.db.prepare('SELECT image_id AS id, candidates, error, draft, generated_at AS generatedAt FROM reviews WHERE image_id = ?')
    return ids.flatMap((id) => (read.get(id) as ReviewSnapshot | undefined) ?? [])
  }

  allIds(): number[] {
    return this.list().map((item) => item.id)
  }

  /** Takes images out of the queue. "processed" stays out of later scans and "cleared" can come back. */
  dismiss(ids: number[], status: 'processed' | 'cleared'): void {
    this.library.transaction(() => {
      const remove = this.db.prepare('DELETE FROM reviews WHERE image_id = ?')
      for (const id of ids) {
        remove.run(id)
        this.setState(id, status)
      }
    })
  }

  restore(rows: ReviewSnapshot[]): void {
    this.library.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO reviews (image_id, candidates, error, draft, generated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(image_id) DO UPDATE SET candidates = excluded.candidates, error = excluded.error, draft = excluded.draft, generated_at = excluded.generated_at`
      )
      for (const row of rows) {
        insert.run(row.id, row.candidates, row.error, row.draft, row.generatedAt)
        this.setState(row.id, row.error ? 'error' : 'scanned')
      }
    })
  }

  getNames(): CharacterName[] {
    const rows = this.db.prepare('SELECT raw, name, series FROM character_names').all() as Array<{ raw: string; name: string; series: string | null }>
    return rows.map((row) => ({ raw: row.raw, name: row.name, ...(row.series === null ? {} : { series: row.series }) }))
  }

  saveName(raw: string, name: string, series: string | null): void {
    this.db
      .prepare(
        `INSERT INTO character_names (key, raw, name, series) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET raw = excluded.raw, name = excluded.name, series = excluded.series`
      )
      .run(nameKey(raw), raw, name, series)
  }

  /** Every character seen so far: saved names, suggestions in the queue, and folders on disk. */
  knownCharacters(charactersRoot: string): string[] {
    const values = [...this.getNames().map((entry) => entry.raw), ...this.childFolderNames(charactersRoot)]
    for (const item of this.list()) values.push(...item.candidates.map((c) => c.tag), ...(item.draft?.characters ?? []))
    return [...new Map(values.map((raw) => [nameKey(raw), raw])).values()]
  }

  /** Sets are the folders inside the Sets folder. */
  childFolderNames(parent: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.name FROM folders c JOIN folders p ON p.id = c.parent_id
         WHERE p.path_key = ? AND c.missing = 0 ORDER BY c.sort_key`
      )
      .all(pathKey(parent)) as Array<{ name: string }>
    return rows.map((row) => row.name)
  }

  usedNames(): string[] {
    const rows = this.db.prepare('SELECT name_key FROM images WHERE missing = 0').all() as Array<{ name_key: string }>
    return rows.map((row) => row.name_key)
  }

  enqueueDiscord(id: number, characters: string[], setName: string | null): void {
    this.db
      .prepare(
        `INSERT INTO discord_queue (image_id, characters, set_name, queued_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(image_id) DO UPDATE SET characters = excluded.characters, set_name = excluded.set_name, queued_at = excluded.queued_at, last_error = NULL`
      )
      .run(id, JSON.stringify(characters), setName, Date.now())
  }

  dequeueDiscord(ids: number[]): void {
    const remove = this.db.prepare('DELETE FROM discord_queue WHERE image_id = ?')
    for (const id of ids) remove.run(id)
  }

  queueSnapshot(ids: number[]): QueuedImage[] {
    const read = this.db.prepare('SELECT image_id AS imageId, characters, set_name AS setName, queued_at AS queuedAt FROM discord_queue WHERE image_id = ?')
    return ids.flatMap((id) => (read.get(id) as QueuedImage | undefined) ?? [])
  }

  restoreQueue(rows: QueuedImage[]): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO discord_queue (image_id, characters, set_name, queued_at) VALUES (?, ?, ?, ?)')
    this.library.transaction(() => {
      for (const row of rows) insert.run(row.imageId, row.characters, row.setName, row.queuedAt)
    })
  }

  discordCount(): number {
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM discord_queue q JOIN images i ON i.id = q.image_id WHERE i.missing = 0')
      .get() as { n: number }
    return n
  }
}
