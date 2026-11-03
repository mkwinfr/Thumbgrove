import { useEffect, useState, type FormEvent } from 'react'
import { BookImage } from 'lucide-react'
import type { CatalogueInfo } from '../../../../shared/api'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'
import { useLibraryStore } from '../folders/libraryStore'

/** Adds selected images or a whole folder to an existing or new catalogue. */
export function AddToCatalogueDialog() {
  const target = useLibraryStore((s) => s.catalogueTarget)
  const close = useLibraryStore((s) => s.setCatalogueTarget)
  const clearSelection = useLibraryStore((s) => s.clearSelection)
  const notify = useAppStore((s) => s.notify)
  const [catalogues, setCatalogues] = useState<CatalogueInfo[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    setName('')
    setError(null)
    void window.thumbGrove.getCatalogues().then(setCatalogues)
  }, [target])

  const addTo = async (catalogue: CatalogueInfo): Promise<void> => {
    if (!target) return
    try {
      const added = target.kind === 'folder' ? await window.thumbGrove.addFolderToCatalogue(catalogue.id, target.folder.id) : await window.thumbGrove.addToCatalogue(catalogue.id, target.ids)
      notify(added ? `Added ${added.toLocaleString()} to ${catalogue.name}` : `Already in ${catalogue.name}`)
      clearSelection()
      close(null)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    try {
      await addTo(await window.thumbGrove.createCatalogue(name, ''))
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  const count = target?.kind === 'images' ? target.ids.length : (target?.folder.totalCount ?? 0)

  return (
    <Dialog open={target !== null} title={`Add ${count.toLocaleString()} ${count === 1 ? 'image' : 'images'} to a catalogue`} onClose={() => close(null)}>
      <div className="picker">
        {catalogues.length > 0 && (
          <ul className="picker-list" aria-label="Catalogues">
            {catalogues.map((catalogue) => (
              <li key={catalogue.id}>
                <button className="picker-row" onClick={() => void addTo(catalogue)}>
                  <BookImage size={14} />
                  <span>
                    <strong>{catalogue.name}</strong>
                    <small>{catalogue.imageCount.toLocaleString()} images</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="picker-create" onSubmit={(event) => void create(event)}>
          <input className="input" aria-label="New catalogue name" autoFocus placeholder="New catalogue name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" className="button primary" disabled={!name.trim()}>
            Create
          </button>
        </form>
        {error && <p className="panel-warning model-error">{error}</p>}
      </div>
    </Dialog>
  )
}
