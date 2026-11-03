import { useCallback, useEffect, useState, type DragEvent, type FormEvent, type MouseEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowDownToLine, BookImage, ChevronLeft, Download, FolderOpen, ImageOff, Pencil, Plus, Star, Trash2, X } from 'lucide-react'
import { thumbUrl, type CatalogueInfo, type ExportStatus, type ImageInfo } from '../../../../shared/api'
import { ContextMenu } from '../../components/ContextMenu'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'
import { CatalogueViewer } from './CatalogueViewer'

const PAGE = 5000

function CatalogueForm({ catalogue, open, onClose, onCreated }: { catalogue: CatalogueInfo | null; open: boolean; onClose(): void; onCreated?(created: CatalogueInfo): void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName(catalogue?.name ?? '')
      setDescription(catalogue?.description ?? '')
      setError(null)
    }
  }, [open, catalogue])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    try {
      if (catalogue) {
        await window.thumbGrove.updateCatalogue(catalogue.id, name, description)
      } else {
        onCreated?.(await window.thumbGrove.createCatalogue(name, description))
      }
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  return (
    <Dialog open={open} title={catalogue ? 'Edit catalogue' : 'New catalogue'} onClose={onClose}>
      <form className="name-form" onSubmit={(event) => void submit(event)}>
        <label>
          Name
          <input className="input" autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Description
          <textarea className="input textarea" maxLength={2000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        {error && <p className="panel-warning model-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function CatalogueDetail({ catalogue, onBack }: { catalogue: CatalogueInfo; onBack(): void }) {
  const [images, setImages] = useState<ImageInfo[]>([])
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [exporting, setExporting] = useState<ExportStatus | null>(null)
  const notify = useAppStore((s) => s.notify)
  const [viewing, setViewing] = useState<number | null>(null)
  const [dragged, setDragged] = useState<number | null>(null)
  const [dropBefore, setDropBefore] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ image: ImageInfo; x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const closeViewer = useCallback(() => setViewing(null), [])

  useEffect(() => {
    const load = (): void => void window.thumbGrove.listCatalogueImages(catalogue.id, 0, PAGE).then((page) => setImages(page.items))
    load()
    return window.thumbGrove.onLibraryEvent((event) => {
      if (event.type === 'catalogues' || event.type === 'changed') load()
      if (event.type === 'export') {
        setExporting(event.status.phase === 'running' ? event.status : null)
        if (event.status.phase === 'error') notify(event.status.error ?? 'The export failed.', 'error')
        if (event.status.phase === 'complete') {
          const { folder, done, skipped } = event.status
          notify(`Exported ${done - skipped} images${skipped ? `, ${skipped} skipped` : ''}`, skipped ? 'error' : 'default', {
            label: 'Show',
            run: () => void window.thumbGrove.showExportedGallery(folder)
          })
        }
      }
    })
  }, [catalogue.id, notify])

  const startExport = async (): Promise<void> => {
    try {
      await window.thumbGrove.exportCatalogue(catalogue.id)
    } catch (failure) {
      notify(errorMessage(failure), 'error')
    }
  }

  return (
    <div className="browse">
      <header className="review-header browse-header">
        <div className="browse-title">
          <button className="icon-button" aria-label="All catalogues" title="All catalogues" onClick={onBack}>
            <ChevronLeft size={20} />
          </button>
          <div className="catalogue-heading">
            <h1>{catalogue.name}</h1>
            <p>{catalogue.description || `${images.length.toLocaleString()} ${images.length === 1 ? 'image' : 'images'}`}</p>
          </div>
        </div>
        <div className="browse-tools">
          {confirmDelete ? (
            <>
              <button className="button" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
              <button
                className="button danger-solid"
                title="Your images aren't deleted"
                onClick={() => {
                  void window.thumbGrove.deleteCatalogue(catalogue.id)
                  onBack()
                }}
              >
                Delete catalogue
              </button>
            </>
          ) : (
            <>
              <button className="button icon-only danger" aria-label="Delete catalogue" title="Delete catalogue. Your images aren't deleted." onClick={() => setConfirmDelete(true)}>
                <Trash2 size={16} />
              </button>
              <button className="button" onClick={() => setEditing(true)}>
                <Pencil size={15} />
                Edit
              </button>
              <button className="button primary" disabled={!images.length || exporting !== null} title="Save a folder with copies of the images and a gallery that opens in any browser" onClick={() => void startExport()}>
                <Download size={15} />
                {exporting ? `Exporting ${exporting.done} of ${exporting.total}` : 'Export gallery'}
              </button>
            </>
          )}
        </div>
      </header>
      <section className="card browse-main">
        {images.length ? (
          <div className="catalogue-grid">
            <AnimatePresence initial={false}>
              {images.map((image) => (
                <motion.div
                  key={image.id}
                  layout="position"
                  className={`catalogue-tile${dropBefore === image.id ? ' drop-before' : ''}`}
                  title={`${image.name}. Drag to reorder.`}
                  exit={{ opacity: 0, scale: 0.9 }}
                  draggable
                  onDragStartCapture={(event: DragEvent) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', image.name)
                    setDragged(image.id)
                  }}
                  onDragOver={(event: DragEvent) => {
                    if (dragged === null || dragged === image.id) return
                    event.preventDefault()
                    setDropBefore(image.id)
                  }}
                  onDrop={(event: DragEvent) => {
                    event.preventDefault()
                    if (dragged !== null && dragged !== image.id) void window.thumbGrove.moveInCatalogue(catalogue.id, dragged, image.id)
                    setDragged(null)
                    setDropBefore(null)
                  }}
                  onDragEnd={() => {
                    setDragged(null)
                    setDropBefore(null)
                  }}
                  onContextMenu={(event: MouseEvent) => {
                    event.preventDefault()
                    setMenu({ image, x: event.clientX, y: event.clientY })
                  }}
                >
                  <button className="catalogue-open" aria-label={`Open ${image.name}`} onClick={() => setViewing(images.indexOf(image))}>
                    <img src={thumbUrl(image.id, image.mtimeMs)} alt="" loading="lazy" decoding="async" draggable={false} />
                  </button>
                  {catalogue.coverId === image.id && (
                    <span className="tile-favorite" title="Catalogue cover">
                      <Star size={13} />
                    </span>
                  )}
                  <button className="queue-remove" aria-label={`Remove ${image.name} from this catalogue`} title="Remove from this catalogue" onClick={() => void window.thumbGrove.removeFromCatalogue(catalogue.id, [image.id])}>
                    <X size={12} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <div className="grid-empty-static">
            <ImageOff size={24} />
            In Folders, right-click images or a folder and choose Add to catalogue.
          </div>
        )}
      </section>
      <CatalogueForm catalogue={catalogue} open={editing} onClose={() => setEditing(false)} />
      <CatalogueViewer images={images} index={viewing} onChange={setViewing} onClose={closeViewer} />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Image actions"
          onClose={closeMenu}
          items={[
            {
              label: catalogue.coverId === menu.image.id ? 'Use the first image as cover' : 'Set as cover',
              icon: Star,
              run: () => void window.thumbGrove.setCatalogueCover(catalogue.id, catalogue.coverId === menu.image.id ? null : menu.image.id)
            },
            { label: 'Move to the end', icon: ArrowDownToLine, run: () => void window.thumbGrove.moveInCatalogue(catalogue.id, menu.image.id, null) },
            { label: 'Show in Explorer', icon: FolderOpen, run: () => void window.thumbGrove.revealImage(menu.image.id) },
            { label: 'Remove from catalogue', icon: X, danger: true, separatorBefore: true, run: () => void window.thumbGrove.removeFromCatalogue(catalogue.id, [menu.image.id]) }
          ]}
        />
      )}
    </div>
  )
}

export function CataloguesView() {
  const [catalogues, setCatalogues] = useState<CatalogueInfo[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const load = (): void => void window.thumbGrove.getCatalogues().then(setCatalogues)
    load()
    return window.thumbGrove.onLibraryEvent((event) => {
      if (event.type === 'catalogues' || event.type === 'changed') load()
    })
  }, [])

  const open = catalogues.find((catalogue) => catalogue.id === openId)
  if (open) return <CatalogueDetail catalogue={open} onBack={() => setOpenId(null)} />

  return (
    <div className="browse">
      <header className="review-header browse-header">
        <div className="browse-title">
          <h1>Catalogues</h1>
        </div>
        <div className="browse-tools">
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={15} />
            New catalogue
          </button>
        </div>
      </header>
      {catalogues.length ? (
        <div className="catalogue-list">
          {catalogues.map((catalogue) => (
            <button key={catalogue.id} className="tile folder-tile catalogue-card" onClick={() => setOpenId(catalogue.id)}>
              {catalogue.coverId !== null ? (
                <img className="tile-image loaded" src={thumbUrl(catalogue.coverId, catalogue.coverVersion)} alt="" decoding="async" draggable={false} />
              ) : (
                <span className="tile-fallback">
                  <BookImage size={26} strokeWidth={1.5} />
                </span>
              )}
              <span className="folder-caption">
                <strong>{catalogue.name}</strong>
                <small>
                  {catalogue.imageCount.toLocaleString()} {catalogue.imageCount === 1 ? 'image' : 'images'}
                </small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="placeholder">
          <div className="rings" aria-hidden="true">
            <span />
            <span />
            <span />
            <div className="rings-core">
              <BookImage size={28} strokeWidth={1.6} />
            </div>
          </div>
          <h1>No catalogues yet</h1>
          <p>Curate images into collections, then export them as a gallery that works offline.</p>
          <button className="button primary" onClick={() => setCreating(true)}>
            New catalogue
          </button>
        </div>
      )}
      <CatalogueForm catalogue={null} open={creating} onClose={() => setCreating(false)} onCreated={(created) => setOpenId(created.id)} />
    </div>
  )
}
