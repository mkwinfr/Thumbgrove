import { useEffect, useState, type FormEvent } from 'react'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'
import { useLibraryStore } from './libraryStore'

function imageCount(total: number): string {
  return `${total.toLocaleString()} ${total === 1 ? 'image' : 'images'}`
}

const TITLES = {
  rename: 'Rename folder',
  create: 'New folder',
  delete: 'Delete folder',
  untrack: 'Untrack folder',
  stop: 'Stop watching folder'
}

/** Asks for a new name, or for confirmation before a folder action takes effect. */
export function FolderActionDialog() {
  const action = useLibraryStore((s) => s.folderAction)
  const close = useLibraryStore((s) => s.setFolderAction)
  const removeRoot = useLibraryStore((s) => s.removeRoot)
  const notify = useAppStore((s) => s.notify)
  const toggleTree = useLibraryStore((s) => s.toggleTree)
  const expanded = useLibraryStore((s) => (action ? Boolean(s.expanded[action.folder.id]) : false))
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    if (!action) return
    setName(action.kind === 'create' ? '' : action.folder.name)
    setError(null)
    setWorking(false)
  }, [action])

  if (!action) return <Dialog open={false} title="" onClose={() => close(null)}>{null}</Dialog>
  const { kind, folder } = action

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setWorking(true)
    setError(null)
    try {
      if (kind === 'rename') {
        await window.thumbGrove.renameFolder(folder.id, name)
        const originalName = folder.name
        notify(`Renamed to “${name.trim()}”`, 'default', {
          label: 'Undo',
          run: () => {
            useAppStore.setState({ toasts: [] })
            window.thumbGrove.renameFolder(folder.id, originalName).catch((failure: unknown) => notify(errorMessage(failure), 'error'))
          }
        })
      } else if (kind === 'create') {
        await window.thumbGrove.createFolder(folder.id, name)
        notify(`Created “${name.trim()}”`)
        if (!expanded) void toggleTree(folder.id)
      } else if (kind === 'delete') {
        await window.thumbGrove.deleteFolder(folder.id)
        notify(`Sent “${folder.name}” to the Recycle Bin`)
      } else if (kind === 'untrack') {
        await window.thumbGrove.untrackFolder(folder.id)
        notify(`Untracked “${folder.name}”. You can track it again in Settings.`)
      } else {
        await removeRoot(folder.rootId)
      }
      close(null)
    } catch (failure) {
      setError(errorMessage(failure))
      setWorking(false)
    }
  }

  const usesName = kind === 'rename' || kind === 'create'
  const unchanged = usesName && (!name.trim() || (kind === 'rename' && name.trim() === folder.name))

  return (
    <Dialog open title={TITLES[kind]} onClose={() => close(null)}>
      <form className="name-form" onSubmit={(event) => void submit(event)}>
        {usesName && (
          <label>
            {kind === 'create' ? `Folder name, inside ${folder.name}` : 'Folder name'}
            <input
              className="input"
              autoFocus
              maxLength={120}
              spellCheck={false}
              value={name}
              onFocus={(event) => event.target.select()}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        {kind === 'delete' && (
          <p className="dialog-text">
            <strong>{folder.name}</strong> and everything inside it, including {imageCount(folder.totalCount)}, will go to the
            Windows Recycle Bin. You can restore it from there.
          </p>
        )}
        {kind === 'untrack' && (
          <p className="dialog-text">
            Thumb Grove will stop showing <strong>{folder.name}</strong> and its {imageCount(folder.totalCount)}, and they'll leave the
            review and Discord queues. The files stay on disk, and you can track it again in Settings.
          </p>
        )}
        {kind === 'stop' && (
          <p className="dialog-text">
            Thumb Grove will forget <strong>{folder.name}</strong> and its {imageCount(folder.totalCount)}, and they'll leave the review
            and Discord queues. The files stay on disk.
          </p>
        )}
        {error && <p className="panel-warning model-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className={`button ${usesName ? 'primary' : 'danger-solid'}`} disabled={working || unchanged}>
            {kind === 'rename' ? 'Rename' : kind === 'create' ? 'Create' : kind === 'delete' ? 'Send to Recycle Bin' : kind === 'untrack' ? 'Untrack' : 'Stop watching'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
