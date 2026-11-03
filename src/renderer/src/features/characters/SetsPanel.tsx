import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { FolderOpen, Merge, Pencil, Search, Send } from 'lucide-react'
import type { SetEntry } from '../../../../shared/api'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'
import { useLibraryStore } from '../folders/libraryStore'

function RenameDialog({ set, onClose }: { set: SetEntry | null; onClose(): void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setName(set?.name ?? '')
    setError(null)
  }, [set])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!set) return
    try {
      await window.thumbGrove.renameSet(set.name, name)
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  return (
    <Dialog open={set !== null} title="Rename set" onClose={onClose}>
      <form className="name-form" onSubmit={(event) => void submit(event)}>
        <label>
          Name
          <input className="input" autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <p className="form-note">Its folder, tags, and Discord thread link move to the new name. Filenames already on disk stay as they are.</p>
        {error && <p className="panel-warning model-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!name.trim() || name.trim() === set?.name}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function MergeDialog({ from, sets, onClose }: { from: SetEntry | null; sets: SetEntry[]; onClose(): void }) {
  const notify = useAppStore((s) => s.notify)
  const [query, setQuery] = useState('')
  const [into, setInto] = useState<SetEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    setQuery('')
    setInto(null)
    setError(null)
    setWorking(false)
  }, [from])

  const options = sets.filter((set) => set.key !== from?.key && set.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 40)

  const merge = async (): Promise<void> => {
    if (!from || !into) return
    setWorking(true)
    try {
      const { moved, failed } = await window.thumbGrove.mergeSets(from.name, into.name)
      notify(`Merged ${from.name} into ${into.name}. Moved ${moved} ${moved === 1 ? 'image' : 'images'}${failed ? `, ${failed} could not be moved` : ''}.`, failed ? 'error' : 'default')
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
      setWorking(false)
    }
  }

  return (
    <Dialog open={from !== null} title={`Merge ${from?.name ?? ''}`} onClose={onClose}>
      <div className="picker">
        <p className="dialog-text">Choose the set to keep. Images in this set's folder move into it, tags and thread links carry over, and files with the same name get a number added. This has no undo.</p>
        <div className="search-field picker-search">
          <Search size={15} />
          <input className="input" autoFocus aria-label="Search sets" placeholder="Search sets" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <ul className="picker-list" role="listbox" aria-label="Sets">
          {!options.length && <li className="thread-empty">No other sets match.</li>}
          {options.map((set) => (
            <li key={set.key} role="option" aria-selected={into?.key === set.key}>
              <button className={`picker-row${into?.key === set.key ? ' chosen' : ''}`} onClick={() => setInto(set)}>
                <span>
                  <strong>{set.name}</strong>
                  <small>{set.imageCount.toLocaleString()} images</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="panel-warning model-error">{error}</p>}
        <div className="form-actions">
          <button className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="button danger-solid" disabled={!into || working} onClick={() => void merge()}>
            {into ? `Merge into ${into.name}` : 'Merge'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

export function SetsPanel({ query }: { query: string }) {
  const [sets, setSets] = useState<SetEntry[]>([])
  const [renaming, setRenaming] = useState<SetEntry | null>(null)
  const [merging, setMerging] = useState<SetEntry | null>(null)
  const setView = useAppStore((s) => s.setView)

  useEffect(() => {
    const load = (): void => void window.thumbGrove.getSets().then(setSets)
    load()
    return window.thumbGrove.onLibraryEvent((event) => {
      if (event.type === 'changed' || event.type === 'reviews' || event.type === 'discord') load()
    })
  }, [])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? sets.filter((set) => set.name.toLowerCase().includes(needle)) : sets
  }, [sets, query])

  const openFolder = (id: number): void => {
    setView('folders')
    void useLibraryStore.getState().setMode('folders').then(() => useLibraryStore.getState().open(id))
  }

  return (
    <section className="card history">
      {!visible.length ? (
        <div className="grid-empty-static">{query ? `No sets match “${query}”.` : 'Sets appear here once your Sets folder has folders in it.'}</div>
      ) : (
        <ul className="thread-list">
          <li className="character-head set-head" aria-hidden="true">
            <span>Name</span>
            <span>Images</span>
            <span />
          </li>
          {visible.map((set) => (
            <li key={set.key} className="character-row set-row">
              <strong>{set.name}</strong>
              <span className="character-count">
                {set.imageCount.toLocaleString()}
                {set.threadId && (
                  <span title="Connected to a Discord thread">
                    <Send size={12} />
                  </span>
                )}
              </span>
              <span className="character-actions">
                {set.folderId !== null && (
                  <button className="icon-button small" aria-label={`Open ${set.name}'s folder`} title="Open folder" onClick={() => openFolder(set.folderId!)}>
                    <FolderOpen size={15} />
                  </button>
                )}
                <button className="icon-button small" aria-label={`Merge ${set.name}`} title="Merge into another set" onClick={() => setMerging(set)}>
                  <Merge size={15} />
                </button>
                <button className="icon-button small" aria-label={`Rename ${set.name}`} title="Rename" onClick={() => setRenaming(set)}>
                  <Pencil size={15} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <RenameDialog set={renaming} onClose={() => setRenaming(null)} />
      <MergeDialog from={merging} sets={sets} onClose={() => setMerging(null)} />
    </section>
  )
}
