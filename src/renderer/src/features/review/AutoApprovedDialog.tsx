import { useEffect, useState } from 'react'
import { thumbUrl, type AutoApproval } from '../../../../shared/api'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'

function when(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Lists what auto-approve moved without you seeing it, so a wrong match can be put back. */
export function AutoApprovedDialog() {
  const open = useAppStore((s) => s.autoApprovedOpen)
  const setOpen = useAppStore((s) => s.setAutoApprovedOpen)
  const notify = useAppStore((s) => s.notify)
  const [items, setItems] = useState<AutoApproval[]>([])
  const [working, setWorking] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)

  const load = (): void => void window.thumbGrove.getAutoApprovals().then(setItems)

  useEffect(() => {
    if (open) {
      setConfirmAll(false)
      load()
    }
  }, [open])

  const undo = async (ids: number[] | null): Promise<void> => {
    setWorking(true)
    setConfirmAll(false)
    try {
      const { undone, failed } = await window.thumbGrove.undoAutoApprovals(ids)
      if (undone) notify(`Put ${undone} ${undone === 1 ? 'image' : 'images'} back in the review queue`)
      if (failed.length) notify(`${failed.length} could not be undone. ${failed[0]}`, 'error')
      load()
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setWorking(false)
    }
  }

  const clear = async (): Promise<void> => {
    await window.thumbGrove.clearAutoApprovals()
    load()
  }

  return (
    <Dialog open={open} title="Auto-approved images" onClose={() => setOpen(false)}>
      <div className="picker">
        {items.length ? (
          <>
            <p className="dialog-text">These went straight to their character folders and the Discord queue. Undo puts an image back where it was and returns it to review.</p>
            <ul className="picker-list auto-list" aria-label="Auto-approved images">
              {items.map((item) => (
                <li key={item.id} className="auto-row">
                  <img src={thumbUrl(item.imageId, item.mtimeMs)} alt="" loading="lazy" decoding="async" />
                  <span className="auto-text">
                    <strong title={item.name}>{item.character}</strong>
                    <small title={item.name}>
                      {item.name} · {when(item.approvedAt)}
                    </small>
                  </span>
                  <button className="button compact" disabled={working} onClick={() => void undo([item.id])}>
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="dialog-text">Nothing has been auto-approved since this list was last cleared.</p>
        )}
        <div className="form-actions">
          {items.length > 0 && (
            <button className="button ghost form-action-left" title="Forgets this list. The images stay where they are." onClick={() => void clear()}>
              Clear list
            </button>
          )}
          {items.length > 1 &&
            (confirmAll ? (
              <button className="button danger-solid" disabled={working} onClick={() => void undo(null)}>
                Undo all {items.length}
              </button>
            ) : (
              <button className="button" disabled={working} onClick={() => setConfirmAll(true)}>
                Undo all
              </button>
            ))}
          <button className="button primary" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  )
}
