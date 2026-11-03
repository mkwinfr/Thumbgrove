import { Check } from 'lucide-react'
import { motion } from 'motion/react'
import { useAppStore } from '../../store'

export function EmptyQueue() {
  const setView = useAppStore((s) => s.setView)
  const queued = useAppStore((s) => s.discordQueued)
  return (
    <div className="placeholder">
      <motion.div
        className="rings"
        aria-hidden="true"
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 180, damping: 18 }}
      >
        <span />
        <span />
        <span />
        <div className="rings-core teal">
          <Check size={28} strokeWidth={2} />
        </div>
      </motion.div>
      <h1>All caught up</h1>
      <p>
        {queued ? `${queued} ${queued === 1 ? 'image is' : 'images are'} in the Discord queue. ` : ''}
        Open a folder and choose Scan folder to review more.
      </p>
      <button className="button" onClick={() => setView('folders')}>
        Go to Folders
      </button>
    </div>
  )
}
