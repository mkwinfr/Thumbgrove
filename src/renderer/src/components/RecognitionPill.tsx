import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { useAppStore } from '../store'

export function isRecognitionBusy(phase: string | undefined): boolean {
  return phase === 'loading' || phase === 'running' || phase === 'cancelling' || phase === 'downloading'
}

/** Shows scan progress wherever the user is, and lets them cancel it. */
export function RecognitionPill() {
  const status = useAppStore((s) => s.recognition)
  if (!status || !isRecognitionBusy(status.phase) || status.phase === 'downloading') return null
  const text =
    status.phase === 'cancelling'
      ? 'Stopping after this image'
      : status.phase === 'loading'
        ? 'Loading the model'
        : `Scanning ${status.done + 1} of ${status.total}${status.provider ? ` · ${status.provider}` : ''}`
  return (
    <motion.span className="scan-pill recognition-pill" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
      <span className="scan-dot" />
      {text}
      {status.phase !== 'cancelling' && (
        <button className="icon-button small" aria-label="Cancel scan" title="Cancel scan" onClick={() => void window.thumbGrove.cancelRecognition()}>
          <X size={13} />
        </button>
      )}
    </motion.span>
  )
}
