import { useEffect } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { imageUrl, thumbUrl } from '../../../../shared/api'
import { useAppStore } from '../../store'
import type { ExitKind } from '../../types'

const EASE = [0.22, 1, 0.36, 1] as const
const MAX_FANNED = 5

// Images resolve from blurred to sharp as they arrive. How one leaves depends on what happened to it.
const imageVariants: Variants = {
  enter: (kind: ExitKind) => ({
    opacity: 0,
    filter: 'blur(22px)',
    scale: 1.04,
    x: kind === 'previous' ? -36 : kind === 'next' ? 36 : 0
  }),
  center: {
    opacity: 1,
    filter: 'blur(0px)',
    scale: 1,
    x: 0,
    transition: { duration: 0.42, ease: EASE }
  },
  exit: (kind: ExitKind) => {
    const fast = { duration: 0.26, ease: EASE }
    if (kind === 'apply') return { opacity: 0, scale: 0.86, y: -24, filter: 'blur(8px)', transition: fast }
    if (kind === 'skip') return { opacity: 0, x: -120, rotate: -3, filter: 'blur(6px)', transition: fast }
    if (kind === 'delete') return { opacity: 0, scale: 0.8, y: 60, rotate: 3, filter: 'blur(10px) saturate(0)', transition: fast }
    return { opacity: 0, x: kind === 'previous' ? 36 : -36, filter: 'blur(10px)', transition: fast }
  }
}

function FannedSelection({ ids }: { ids: number[] }) {
  const sources = useAppStore(
    useShallow((s) =>
      ids.slice(0, MAX_FANNED).map((id) => {
        const item = s.queue.find((i) => i.id === id)
        return item ? thumbUrl(item.id, item.mtimeMs) : ''
      })
    )
  )
  const middle = (sources.length - 1) / 2
  return (
    <div className="fan">
      <div className="fan-cards">
        {sources.map((src, index) => (
          <motion.img
            key={ids[index]}
            src={src}
            alt=""
            className="fan-card"
            initial={{ opacity: 0, scale: 0.7, x: 0, rotate: 0 }}
            animate={{ opacity: 1, scale: 1 - Math.abs(index - middle) * 0.04, x: (index - middle) * 88, rotate: (index - middle) * 5 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
            style={{ zIndex: 10 - Math.abs(index - middle) }}
          />
        ))}
      </div>
      <strong>{ids.length} images selected</strong>
      <span>Changes on the right apply to all of them.</span>
    </div>
  )
}

export function Stage() {
  const item = useAppStore((s) => s.queue.find((i) => i.id === s.focusId) ?? null)
  const index = useAppStore((s) => s.queue.findIndex((i) => i.id === s.focusId))
  const total = useAppStore((s) => s.queue.length)
  const nextItem = useAppStore((s) => {
    const position = s.queue.findIndex((i) => i.id === s.focusId)
    return position >= 0 ? s.queue[position + 1] : undefined
  })
  const selection = useAppStore((s) => s.selection)
  const exitKind = useAppStore((s) => s.exitKind)
  const step = useAppStore((s) => s.step)
  const batch = selection.length > 1

  // Loads the next image ahead of time so that moving on feels instant.
  useEffect(() => {
    if (nextItem) new Image().src = imageUrl(nextItem.id, nextItem.mtimeMs)
  }, [nextItem])

  return (
    <section id="review-stage" className="card stage" aria-label="Current image">
      <AnimatePresence initial={false}>
        {item && !batch && (
          <motion.img
            key={`${item.id}-glow`}
            src={thumbUrl(item.id, item.mtimeMs)}
            alt=""
            className="stage-glow"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.4 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
          />
        )}
      </AnimatePresence>

      {batch ? (
        <FannedSelection ids={selection} />
      ) : (
        <AnimatePresence custom={exitKind} initial={false}>
          {item && (
            <motion.img
              key={item.id}
              src={imageUrl(item.id, item.mtimeMs)}
              alt={item.name}
              className="stage-image"
              custom={exitKind}
              variants={imageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              draggable={false}
            />
          )}
        </AnimatePresence>
      )}

      {item && !batch && (
        <>
          <div className="stage-caption">
            <span className="pill">
              {index + 1} of {total}
            </span>
            <span className="stage-file" title={`${item.folder}\\${item.name}`}>
              {item.name}
              <small>{item.folder.split('\\').slice(-2).join('\\')}</small>
            </span>
          </div>
          <button className="stage-nav previous" aria-label="Previous image" disabled={index <= 0} onClick={() => step(-1)}>
            <ChevronLeft size={22} />
          </button>
          <button className="stage-nav next" aria-label="Next image" disabled={index >= total - 1} onClick={() => step(1)}>
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </section>
  )
}
