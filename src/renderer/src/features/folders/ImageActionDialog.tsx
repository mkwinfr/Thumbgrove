import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'
import { useLibraryStore } from './libraryStore'

/** Asks for a new name, or for confirmation before sending images to the Recycle Bin. */
export function ImageActionDialog() {
  const action = useLibraryStore((s) => s.imageAction)
  const close = useLibraryStore((s) => s.setImageAction)
  const finishImages = useLibraryStore((s) => s.finishImages)
  const clearSelection = useLibraryStore((s) => s.clearSelection)
  const notify = useAppStore((s) => s.notify)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!action) return
    setName(action.name ?? '')
    setError(null)
    setWorking(false)
  }, [action])

  if (!action) return <Dialog open={false} title="" onClose={() => close(null)}>{null}</Dialog>
  const { kind, ids } = action
  const count = ids.length
  const batch = kind === 'rename' && action.name === null

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setWorking(true)
    setError(null)
    try {
      if (kind === 'delete') {
        const sent = await window.thumbGrove.deleteImages(ids)
        clearSelection()
        notify(sent === 1 ? 'Sent to the Recycle Bin' : `Sent ${sent} images to the Recycle Bin`)
        close(null)
        return
      }
      const outcome = batch
        ? await window.thumbGrove.renameImagesToBase(ids, name.trim())
        : await window.thumbGrove.renameImages([{ id: ids[0]!, name: name.trim() }])
      const failure = outcome.results.length === 1 ? outcome.results[0]!.error : undefined
      if (failure) {
        setError(failure)
        setWorking(false)
        return
      }
      finishImages(outcome, 'Renamed')
      close(null)
    } catch (failure) {
      setError(errorMessage(failure))
      setWorking(false)
    }
  }

  const title = kind === 'delete' ? (count === 1 ? 'Delete image' : `Delete ${count} images`) : batch ? `Rename ${count} images` : 'Rename image'
  const unchanged = kind === 'rename' && (!name.trim() || name.trim() === action.name)

  return (
    <Dialog open title={title} onClose={() => close(null)}>
      <form className="name-form" onSubmit={(event) => void submit(event)}>
        {kind === 'rename' ? (
          <label>
            {batch ? 'New name. Each image gets a number after it.' : 'Filename'}
            <input
              ref={inputRef}
              className="input"
              autoFocus
              maxLength={200}
              spellCheck={false}
              value={name}
              // Selects the name without its extension, which has to stay the same.
              onFocus={(event) => event.target.setSelectionRange(0, event.target.value.lastIndexOf('.') > 0 ? event.target.value.lastIndexOf('.') : event.target.value.length)}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : (
          <p className="dialog-text">
            {count === 1 && action.name ? <strong>{action.name}</strong> : <strong>{count} images</strong>} will go to the Windows Recycle
            Bin and leave the review and Discord queues. You can restore {count === 1 ? 'it' : 'them'} from there.
          </p>
        )}
        {error && <p className="panel-warning model-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className={`button ${kind === 'rename' ? 'primary' : 'danger-solid'}`} disabled={working || unchanged}>
            {kind === 'rename' ? 'Rename' : 'Send to Recycle Bin'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
