import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { imageUrl, thumbUrl, type ImageInfo } from '../../../../shared/api'

interface CatalogueViewerProps {
  images: ImageInfo[]
  index: number | null
  onChange(index: number): void
  onClose(): void
}

/** Full-window viewing that follows the catalogue's own order. */
export function CatalogueViewer({ images, index, onChange, onClose }: CatalogueViewerProps) {
  const image = index === null ? undefined : images[index]
  const isOpen = index !== null

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight' && index! < images.length - 1) onChange(index! + 1)
      else if (event.key === 'ArrowLeft' && index! > 0) onChange(index! - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, index, images.length, onChange, onClose])

  return createPortal(
    <AnimatePresence>
      {isOpen && image && (
        <motion.div
          className="viewer"
          role="dialog"
          aria-modal="true"
          aria-label={image.name}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose()
          }}
        >
          <AnimatePresence initial={false}>
            <motion.div
              key={image.id}
              className="viewer-frame"
              initial={{ opacity: 0, filter: 'blur(14px)', scale: 0.985 }}
              animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
              exit={{ opacity: 0, filter: 'blur(8px)', transition: { duration: 0.14 } }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              style={{ backgroundImage: `url("${thumbUrl(image.id, image.mtimeMs)}")` }}
            >
              <img className="viewer-full" src={imageUrl(image.id, image.mtimeMs)} alt={image.name} draggable={false} />
            </motion.div>
          </AnimatePresence>
          <button className="stage-nav previous viewer-nav" aria-label="Previous image" disabled={index === 0} onClick={() => onChange(index! - 1)}>
            <ChevronLeft size={22} />
          </button>
          <button className="stage-nav next viewer-nav" aria-label="Next image" disabled={index === images.length - 1} onClick={() => onChange(index! + 1)}>
            <ChevronRight size={22} />
          </button>
          <button className="icon-button viewer-close" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
          <div className="viewer-bar">
            <span className="pill">
              {index! + 1} of {images.length}
            </span>
            <span className="viewer-name" title={image.name}>
              {image.name}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
