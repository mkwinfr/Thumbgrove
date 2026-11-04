import { Dialog } from '../../components/Dialog'
import { useAppStore } from '../../store'

/** Says why images asked to be queued didn't join the queue. */
export function AlreadyPostedDialog() {
  const notice = useAppStore((s) => s.alreadyPosted)
  const setNotice = useAppStore((s) => s.setAlreadyPosted)
  const count = notice?.count ?? 0
  const queued = notice?.queued ?? 0
  return (
    <Dialog open={notice !== null} title="Already on Discord" onClose={() => setNotice(null)}>
      <p className="dialog-text">
        {count === 1 ? '1 image is' : `${count} images are`} already in {count === 1 ? 'its thread' : 'their threads'}, so {count === 1 ? 'it was' : 'they were'} not added to the queue.
        {queued ? ` The other ${queued === 1 ? 'image was' : `${queued} images were`} added.` : ''}
      </p>
      <div className="form-actions">
        <button className="button primary" autoFocus onClick={() => setNotice(null)}>
          OK
        </button>
      </div>
    </Dialog>
  )
}
