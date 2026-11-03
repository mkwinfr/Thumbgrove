import { GalleryHorizontal, History, LayoutGrid } from 'lucide-react'
import { motion } from 'motion/react'
import { RecognitionPill } from '../../components/RecognitionPill'
import { useAppStore } from '../../store'

export function ReviewHeader() {
  const count = useAppStore((s) => s.queue.length)
  const limit = useAppStore((s) => s.queueLimit)
  const selected = useAppStore((s) => s.selection.length)
  const gridMode = useAppStore((s) => s.gridMode)
  const setGridMode = useAppStore((s) => s.setGridMode)
  const clearQueue = useAppStore((s) => s.clearQueue)
  const autoApproved = useAppStore((s) => s.autoApproved)
  const setAutoApprovedOpen = useAppStore((s) => s.setAutoApprovedOpen)

  return (
    <header className="review-header">
      <div>
        <h1>Review</h1>
        <p>{selected > 1 ? `${selected} selected` : `${count} waiting for you`}</p>
      </div>
      <div className="review-header-tools">
        <RecognitionPill />
        <div className="queue-meter" title={`${count} of ${limit} images in the review queue`}>
          <span>
            {count} <small>/ {limit}</small>
          </span>
          <div className="queue-track">
            <motion.div
              className="queue-fill"
              animate={{ width: `${Math.min(100, (count / limit) * 100)}%` }}
              transition={{ type: 'spring', stiffness: 200, damping: 30 }}
            />
          </div>
        </div>
        <div className="segmented" role="group" aria-label="Review layout">
          <button aria-pressed={!gridMode} aria-label="Single image" title="Single image (G)" onClick={() => setGridMode(false)}>
            {!gridMode && <motion.span layoutId="segment" className="segment-active" />}
            <GalleryHorizontal size={17} />
          </button>
          <button aria-pressed={gridMode} aria-label="Grid" title="Grid (G)" onClick={() => setGridMode(true)}>
            {gridMode && <motion.span layoutId="segment" className="segment-active" />}
            <LayoutGrid size={17} />
          </button>
        </div>
        {autoApproved > 0 && (
          <button className="button ghost" title="See what auto-approve moved, and undo any wrong matches" onClick={() => setAutoApprovedOpen(true)}>
            <History size={15} />
            {autoApproved} auto-approved
          </button>
        )}
        <button className="button ghost" disabled={!count} onClick={() => void clearQueue()}>
          Clear queue
        </button>
      </div>
    </header>
  )
}
