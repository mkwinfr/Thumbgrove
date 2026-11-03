import { motion } from 'motion/react'
import { useAppStore } from '../store'
import { Dialog } from './Dialog'

/** Asked once, before the first scan, because the model is a large download. */
export function ModelDialog() {
  const open = useAppStore((s) => s.modelDialogOpen)
  const setOpen = useAppStore((s) => s.setModelDialogOpen)
  const status = useAppStore((s) => s.recognition)
  const downloading = status?.phase === 'downloading'
  const size = Math.round((status?.modelSize ?? 0) / (1024 * 1024))
  const progress = downloading && status.total ? (status.done / status.total) * 100 : 0

  return (
    <Dialog open={open} title="Download the recognition model" onClose={() => setOpen(false)}>
      <p className="form-note">
        Character recognition needs a {size} MB model. It's downloaded once, then everything runs on this computer and
        your images are never uploaded.
      </p>
      {downloading && (
        <div className="queue-track model-progress" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
          <motion.div className="queue-fill" animate={{ width: `${progress}%` }} />
        </div>
      )}
      {status?.phase === 'error' && status.error && <p className="panel-warning model-error">{status.error}</p>}
      <div className="form-actions model-actions">
        {downloading ? (
          <button className="button ghost" onClick={() => void window.thumbGrove.cancelRecognition()}>
            Cancel download
          </button>
        ) : (
          <>
            <button className="button ghost" onClick={() => setOpen(false)}>
              Not now
            </button>
            <button className="button primary" onClick={() => void window.thumbGrove.downloadModel()}>
              Download
            </button>
          </>
        )}
      </div>
    </Dialog>
  )
}
