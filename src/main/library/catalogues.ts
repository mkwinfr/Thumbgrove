import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { CatalogueInfo, ExportStatus, ImagePage } from '../../shared/api'
import { folderName } from '../../shared/naming'
import type { Library } from './library'

function clean(name: string, description: string): { name: string; description: string } {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 120) throw new Error('Enter a catalogue name of up to 120 characters.')
  return { name: trimmed, description: description.trim().slice(0, 2000) }
}

/** Curated collections. They point at images, so an image can be in several, and files never move. */
export class CatalogueStore {
  constructor(private readonly library: Library) {}

  private get db() {
    return this.library.db
  }

  list(): CatalogueInfo[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.description, c.cover_image_id,
           (SELECT COUNT(*) FROM catalogue_images ci JOIN images i ON i.id = ci.image_id WHERE ci.catalogue_id = c.id AND i.missing = 0) AS image_count
         FROM catalogues c ORDER BY c.name_key`
      )
      .all() as Array<{ id: number; name: string; description: string; cover_image_id: number | null; image_count: number }>
    const cover = this.db.prepare(
      `SELECT i.id, i.mtime_ms FROM catalogue_images ci JOIN images i ON i.id = ci.image_id
       WHERE ci.catalogue_id = ? AND i.missing = 0 ORDER BY ci.position LIMIT 1`
    )
    const chosen = this.db.prepare('SELECT id, mtime_ms FROM images WHERE id = ? AND missing = 0')
    return rows.map((row) => {
      const picked = row.cover_image_id === null ? undefined : (chosen.get(row.cover_image_id) as { id: number; mtime_ms: number } | undefined)
      const first = picked ?? (cover.get(row.id) as { id: number; mtime_ms: number } | undefined)
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        imageCount: row.image_count,
        coverId: first?.id ?? null,
        coverVersion: first?.mtime_ms ?? 0
      }
    })
  }

  private assertFreeName(name: string, exceptId: number | null): void {
    const taken = this.db.prepare('SELECT id FROM catalogues WHERE name_key = ?').get(name.toLowerCase()) as { id: number } | undefined
    if (taken && taken.id !== exceptId) throw new Error('A catalogue already has that name.')
  }

  create(name: string, description: string): CatalogueInfo {
    const values = clean(name, description)
    this.assertFreeName(values.name, null)
    const id = Number(
      this.db.prepare('INSERT INTO catalogues (name, name_key, description, created_at) VALUES (?, ?, ?, ?)').run(values.name, values.name.toLowerCase(), values.description, Date.now()).lastInsertRowid
    )
    return this.list().find((catalogue) => catalogue.id === id)!
  }

  update(id: number, name: string, description: string): void {
    const values = clean(name, description)
    this.assertFreeName(values.name, id)
    this.db.prepare('UPDATE catalogues SET name = ?, name_key = ?, description = ? WHERE id = ?').run(values.name, values.name.toLowerCase(), values.description, id)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM catalogues WHERE id = ?').run(id)
  }

  /** Adds images to the end, skipping any already in it. Returns how many were new. */
  add(id: number, imageIds: number[]): number {
    if (!this.db.prepare('SELECT 1 FROM catalogues WHERE id = ?').get(id)) throw new Error('This catalogue no longer exists.')
    const { last } = this.db.prepare('SELECT COALESCE(MAX(position), 0) AS last FROM catalogue_images WHERE catalogue_id = ?').get(id) as { last: number }
    let position = last
    let added = 0
    const insert = this.db.prepare('INSERT OR IGNORE INTO catalogue_images (catalogue_id, image_id, position) VALUES (?, ?, ?)')
    this.library.transaction(() => {
      for (const imageId of imageIds) added += Number(insert.run(id, imageId, ++position).changes)
    })
    return added
  }

  remove(id: number, imageIds: number[]): void {
    const remove = this.db.prepare('DELETE FROM catalogue_images WHERE catalogue_id = ? AND image_id = ?')
    this.library.transaction(() => {
      for (const imageId of imageIds) remove.run(id, imageId)
    })
  }

  /** Moves an image to just before another, or to the end. */
  move(id: number, imageId: number, beforeImageId: number | null): void {
    const rows = this.db.prepare('SELECT image_id FROM catalogue_images WHERE catalogue_id = ? ORDER BY position').all(id) as Array<{ image_id: number }>
    const order = rows.map((row) => row.image_id).filter((other) => other !== imageId)
    if (order.length === rows.length) return
    const index = beforeImageId === null ? -1 : order.indexOf(beforeImageId)
    order.splice(index < 0 ? order.length : index, 0, imageId)
    const write = this.db.prepare('UPDATE catalogue_images SET position = ? WHERE catalogue_id = ? AND image_id = ?')
    this.library.transaction(() => {
      order.forEach((other, position) => write.run(position + 1, id, other))
    })
  }

  setCover(id: number, imageId: number | null): void {
    this.db.prepare('UPDATE catalogues SET cover_image_id = ? WHERE id = ?').run(imageId, id)
  }

  images(id: number, offset: number, limit: number): ImagePage {
    const { total } = this.db
      .prepare('SELECT COUNT(*) AS total FROM catalogue_images ci JOIN images i ON i.id = ci.image_id WHERE ci.catalogue_id = ? AND i.missing = 0')
      .get(id) as { total: number }
    const rows = this.db
      .prepare(
        `SELECT i.id, i.folder_id, i.name, i.size, i.mtime_ms FROM catalogue_images ci JOIN images i ON i.id = ci.image_id
         WHERE ci.catalogue_id = ? AND i.missing = 0 ORDER BY ci.position LIMIT ? OFFSET ?`
      )
      .all(id, limit, offset) as Array<{ id: number; folder_id: number; name: string; size: number; mtime_ms: number }>
    return { total, items: rows.map((r) => ({ id: r.id, folderId: r.folder_id, name: r.name, size: r.size, mtimeMs: r.mtime_ms })) }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** A gallery with no outside dependencies, so it opens in any browser with no connection. */
export function galleryHtml(name: string, description: string, files: string[]): string {
  const tiles = files
    .map((file, index) => {
      const href = `images/${encodeURIComponent(file)}`
      return `<a href="${href}" data-index="${index}" title="${escapeHtml(file)}"><img loading="lazy" src="${href}" alt="${escapeHtml(file)}"></a>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#0f1016;color:#f3f3f8;font:15px/1.5 system-ui,'Segoe UI',sans-serif}
header{padding:32px 24px 8px}h1{margin:0;font-size:28px;font-weight:600}
header p{margin:6px 0 0;color:#a0a1b5;white-space:pre-wrap}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;padding:20px 24px 40px}
main a{display:block;aspect-ratio:4/5;overflow:hidden;border-radius:12px;background:#20212c}
main img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s}main a:hover img{transform:scale(1.03)}
#view{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(6,6,10,.95)}
#view.open{display:flex}#view img{max-width:calc(100vw - 140px);max-height:calc(100vh - 40px);object-fit:contain}
#view button{position:absolute;width:44px;height:44px;border:0;border-radius:50%;background:#20212c;color:#fff;font-size:20px;cursor:pointer}
#prev{left:16px;top:50%}#next{right:16px;top:50%}#close{right:16px;top:16px}
</style>
</head>
<body>
<header><h1>${escapeHtml(name)}</h1><p>${escapeHtml(description || `${files.length} ${files.length === 1 ? 'image' : 'images'}`)}</p></header>
<main>
${tiles}
</main>
<div id="view" role="dialog" aria-modal="true"><img alt=""><button id="prev" aria-label="Previous">&#8249;</button><button id="next" aria-label="Next">&#8250;</button><button id="close" aria-label="Close">&#215;</button></div>
<script>
var links=[].slice.call(document.querySelectorAll('main a')),view=document.getElementById('view'),big=view.querySelector('img'),at=0;
function show(i){at=(i+links.length)%links.length;big.src=links[at].getAttribute('href');big.alt=links[at].title;view.classList.add('open')}
function hide(){view.classList.remove('open');big.src=''}
links.forEach(function(a,i){a.addEventListener('click',function(e){e.preventDefault();show(i)})});
document.getElementById('prev').onclick=function(){show(at-1)};document.getElementById('next').onclick=function(){show(at+1)};document.getElementById('close').onclick=hide;
view.addEventListener('click',function(e){if(e.target===view)hide()});
document.addEventListener('keydown',function(e){if(!view.classList.contains('open'))return;if(e.key==='Escape')hide();if(e.key==='ArrowLeft')show(at-1);if(e.key==='ArrowRight')show(at+1)});
</script>
</body>
</html>
`
}

async function freeFolder(parent: string, name: string): Promise<string> {
  for (let n = 1; n < 100_000; n++) {
    const candidate = path.join(parent, n === 1 ? name : `${name} (${n})`)
    if (!(await fsp.lstat(candidate).then(() => true, () => false))) return candidate
  }
  throw new Error('No free folder name for this export.')
}

/** Writes copies of the images and a gallery to a new folder. An existing folder is never written into. */
export async function exportCatalogue(
  library: Library,
  catalogues: CatalogueStore,
  id: number,
  parent: string,
  onProgress: (status: ExportStatus) => void
): Promise<void> {
  const catalogue = catalogues.list().find((c) => c.id === id)
  if (!catalogue) throw new Error('This catalogue no longer exists.')
  const { items, total } = catalogues.images(id, 0, Number.MAX_SAFE_INTEGER)
  const folder = await freeFolder(parent, folderName(catalogue.name, 'Catalogue'))
  await fsp.mkdir(path.join(folder, 'images'), { recursive: true })

  const used = new Set<string>()
  const files: string[] = []
  let done = 0
  let skipped = 0
  for (const item of items) {
    onProgress({ phase: 'running', done, total, folder, skipped, error: null })
    const file = library.imageFile(item.id)
    try {
      if (!file) throw new Error('missing')
      const extension = path.extname(item.name)
      const stem = item.name.slice(0, item.name.length - extension.length)
      let name = item.name
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${extension}`
      used.add(name.toLowerCase())
      await fsp.copyFile(file.path, path.join(folder, 'images', name), fs.constants.COPYFILE_EXCL)
      files.push(name)
    } catch {
      skipped++
    }
    done++
  }
  await fsp.writeFile(path.join(folder, 'index.html'), galleryHtml(catalogue.name, catalogue.description, files))
  onProgress({ phase: 'complete', done, total, folder, skipped, error: null })
}
