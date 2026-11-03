import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'

interface DialogProps {
  open: boolean
  title: string
  onClose(): void
  children: ReactNode
  className?: string
}

export function Dialog({ open, title, onClose, children, className }: DialogProps) {
  const backdrop = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      // Esc closes only the top dialog when one has opened over another.
      if (event.key === 'Escape' && backdrop.current === [...document.querySelectorAll('.dialog-backdrop')].at(-1)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Rendered at the top of the page so that it always covers the whole window.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={backdrop}
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose()
          }}
        >
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={`dialog${className ? ` ${className}` : ''}`}
            initial={{ opacity: 0, y: 14, scale: 0.97, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="dialog-header">
              <h2>{title}</h2>
              <button className="icon-button" aria-label="Close" onClick={onClose}>
                <X size={18} />
              </button>
            </header>
            {children}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
