import { AnimatePresence, motion } from 'motion/react'
import { useAppStore } from '../store'

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout="position"
            className={`toast${toast.tone === 'error' ? ' error' : ''}`}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 460, damping: 34 }}
          >
            <span title={toast.message}>{toast.message}</span>
            {toast.action && <button onClick={toast.action.run}>{toast.action.label}</button>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
