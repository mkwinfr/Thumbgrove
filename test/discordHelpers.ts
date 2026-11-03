import fs from 'node:fs'
import path from 'node:path'
import { Library as RealLibrary, naturalKey, pathKey } from '../src/main/library/library'
import { ReviewStore } from '../src/main/library/reviews'

/** A library whose images can be added directly, without running a scan. */
export class Library extends RealLibrary {
  static open(base: string, index: string): { library: Library; reviews: ReviewStore } {
    const library = new Library(path.join(base, 'library.db'), {
      autoApprove: false,
      charactersRoot: path.join(index, 'Characters'),
      setsRoot: path.join(index, 'Sets')
    })
    if (!library.getRoots().length) library.addRoot(index)
    return { library, reviews: new ReviewStore(library) }
  }

  private folderFor(dir: string, rootId: number): number {
    const key = pathKey(dir)
    const found = this.db.prepare('SELECT id FROM folders WHERE path_key = ?').get(key) as { id: number } | undefined
    if (found) return found.id
    const parentId = this.folderFor(path.dirname(dir), rootId)
    const name = path.basename(dir)
    return Number(
      this.db
        .prepare('INSERT INTO folders (root_id, parent_id, path, path_key, name, sort_key) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rootId, parentId, dir, key, name, naturalKey(name)).lastInsertRowid
    )
  }

  addImageForTest(file: string): number {
    const rootId = this.getRoots()[0]!.id
    const folderId = this.folderFor(path.dirname(file), rootId)
    const name = path.basename(file)
    const stat = fs.statSync(file)
    return Number(
      this.db
        .prepare('INSERT INTO images (root_id, folder_id, name, name_key, sort_key, size, mtime_ms, file_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(rootId, folderId, name, name.toLowerCase(), naturalKey(name), stat.size, Math.trunc(stat.mtimeMs), String(stat.ino)).lastInsertRowid
    )
  }
}
