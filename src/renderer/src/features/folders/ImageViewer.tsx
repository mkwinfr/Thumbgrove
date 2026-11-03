import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, ChevronRight, FolderOpen, Tags, X } from 'lucide-react'
import { imageUrl, thumbUrl, type ImageInfo } from '../../../../shared/api'
import { imageAt, useLibraryStore, type ViewerState } from './libraryStore'

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Grows out of the tile it was opened from. The thumbnail shows at once while the full image loads. */
function ViewerImage({ image, origin }: { image: ImageInfo; origin: ViewerState['origin'] }) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => setLoaded(false), [image.id])
  const from = origin
    ? {
        opacity: 0.4,
        x: origin.x + origin.width / 2 - window.innerWidth / 2,
        y: origin.y + origin.height / 2 - window.innerHeight / 2,
        scale: Math.min(0.5, origin.height / window.innerHeight),
        filter: 'blur(0px)'
      }
    : { opacity: 0, x: 0, y: 0, scale: 0.985, filter: 'blur(14px)' }

  return (
    <motion.div
      className="viewer-frame"
      initial={from}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.985, filter: 'blur(8px)', transition: { duration: 0.14 } }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
    >
      <img className="viewer-thumb" src={thumbUrl(image.id, image.mtimeMs)} alt="" draggable={false} style={{ opacity: loaded ? 0 : 1 }} />
      <img
        className="viewer-full"
        src={imageUrl(image.id, image.mtimeMs)}
        alt={image.name}
        draggable={false}
        style={{ opacity: loaded ? 1 : 0 }}
        onLoad={() => setLoaded(true)}
      />
    </motion.div>
  )
}

export function ImageViewer() {
  const viewer = useLibraryStore((s) => s.viewer)
  const image = useLibraryStore((s) => (s.viewer ? imageAt(s, s.viewer.index) : undefined))
  const total = useLibraryStore((s) => s.total)
  const close = useLibraryStore((s) => s.closeViewer)
  const step = useLibraryStore((s) => s.stepViewer)
  const setTagTarget = useLibraryStore((s) => s.setTagTarget)
  const tagging = useLibraryStore((s) => s.tagTarget !== null)
  const [tags, setTags] = useState<string[]>([])
  const isOpen = viewer !== null
  const imageId = image?.id

  useEffect(() => {
    if (imageId === undefined || tagging) return
    let current = true
    void window.thumbGrove.getImageTags(imageId).then((list) => {
      if (current) setTags(list)
    })
    return () => {
      current = false
    }
  }, [imageId, tagging])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent): void => {
      // A dialog over the viewer handles its own keys.
      if (document.querySelector('.dialog')) return
      if (event.key === 'Escape') close()
      else if (event.key === 'ArrowRight') step(1)
      else if (event.key === 'ArrowLeft') step(-1)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isOpen, close, step])

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="viewer"
          role="dialog"
          aria-modal="true"
          aria-label={image?.name ?? 'Image'}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close()
          }}
        >
          <AnimatePresence initial={true}>
            {image && <ViewerImage key={image.id} image={image} origin={viewer.origin} />}
          </AnimatePresence>
          <button className="stage-nav previous viewer-nav" aria-label="Previous image" disabled={viewer.index <= 0} onClick={() => step(-1)}>
            <ChevronLeft size={22} />
          </button>
          <button className="stage-nav next viewer-nav" aria-label="Next image" disabled={viewer.index >= total - 1} onClick={() => step(1)}>
            <ChevronRight size={22} />
          </button>
          <button className="icon-button viewer-close" aria-label="Close" onClick={close}>
            <X size={20} />
          </button>
          {image && (
            <div className="viewer-bar">
              <span className="pill">
                {(viewer.index + 1).toLocaleString()} of {total.toLocaleString()}
              </span>
              <span className="viewer-name" title={image.name}>
                {image.name}
              </span>
              <small>{formatSize(image.size)}</small>
              {tags.length > 0 && (
                <small className="viewer-tags" title={tags.join(', ')}>
                  {tags.join(', ')}
                </small>
              )}
              <button className="icon-button small" aria-label="Edit tags" title="Edit tags" onClick={() => setTagTarget({ kind: 'images', ids: [image.id] })}>
                <Tags size={15} />
              </button>
              <button className="icon-button small" aria-label="Show in Explorer" title="Show in Explorer" onClick={() => void window.thumbGrove.revealImage(image.id)}>
                <FolderOpen size={15} />
              </button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
