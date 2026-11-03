import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useAppStore } from '../../store'
import { Stage } from './Stage'
import { Filmstrip } from './Filmstrip'
import { GridBoard } from './GridBoard'
import { Inspector } from './Inspector'
import { ReviewHeader } from './ReviewHeader'
import { EmptyQueue } from './EmptyQueue'

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

function useReviewShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const store = useAppStore.getState()
      // A dialog over Review handles its own keys.
      if (store.editingCharacter || store.view !== 'review' || document.querySelector('.dialog')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void store.undo()
        return
      }
      if (isTyping(event.target)) {
        if (event.key === 'Escape') (event.target as HTMLElement).blur()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        store.selectAll()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const focusField = (id: string): void => {
        event.preventDefault()
        document.getElementById(id)?.focus()
      }
      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault()
          store.step(1)
          break
        case 'ArrowLeft':
          event.preventDefault()
          store.step(-1)
          break
        case 'Enter':
          // A focused button handles Enter itself.
          if (!(event.target instanceof HTMLButtonElement)) void store.apply(event.shiftKey)
          break
        case 's':
        case 'S':
          void store.skip()
          break
        case 'Delete':
          void store.remove()
          break
        case 'c':
        case 'C':
          focusField('review-character-input')
          break
        case 'e':
        case 'E':
          focusField('review-set-input')
          break
        case 'g':
        case 'G':
          store.setGridMode(!store.gridMode)
          break
        case 'Escape':
          store.clearSelection()
          break
        default:
          if (/^[1-5]$/.test(event.key)) {
            const item = store.queue.find((i) => i.id === store.focusId)
            const candidate = item?.candidates[Number(event.key) - 1]
            if (candidate) store.toggleCharacter(candidate.tag)
          }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function ReviewView() {
  const isEmpty = useAppStore((s) => s.queue.length === 0)
  const gridMode = useAppStore((s) => s.gridMode)
  useReviewShortcuts()

  if (isEmpty) {
    return (
      <div className="review">
        <ReviewHeader />
        <EmptyQueue />
      </div>
    )
  }

  return (
    <div className="review">
      <ReviewHeader />
      <div className="review-body">
        <div className="review-left">
          <AnimatePresence mode="wait" initial={false}>
            {gridMode ? (
              <motion.div
                key="grid"
                className="review-pane"
                initial={{ opacity: 0, scale: 0.985 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.985 }}
                transition={{ duration: 0.16 }}
              >
                <GridBoard />
              </motion.div>
            ) : (
              <motion.div
                key="focus"
                className="review-pane review-focus"
                initial={{ opacity: 0, scale: 0.985 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.985 }}
                transition={{ duration: 0.16 }}
              >
                <Stage />
                <Filmstrip />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <Inspector />
      </div>
    </div>
  )
}
