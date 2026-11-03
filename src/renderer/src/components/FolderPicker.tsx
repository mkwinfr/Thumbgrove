import { useEffect, useState } from 'react'
import { Folder, Search, Star } from 'lucide-react'
import type { FolderInfo } from '../../../shared/api'
import { Dialog } from './Dialog'

interface FolderPickerProps {
  open: boolean
  title: string
  actionLabel: string
  onPick(folder: FolderInfo): void
  onClose(): void
}

/** Chooses a folder from the watched folders by searching. Favorites come first. */
export function FolderPicker({ open, title, actionLabel, onPick, onClose }: FolderPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FolderInfo[]>([])
  const [chosen, setChosen] = useState<FolderInfo | null>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setChosen(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let current = true
    const timer = setTimeout(() => {
      void window.thumbGrove.searchFolders(query).then((list) => {
        if (current) setResults(list)
      })
    }, 80)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [open, query])

  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <div className="picker">
        <div className="search-field picker-search">
          <Search size={15} />
          <input
            className="input"
            autoFocus
            aria-label="Search folders"
            placeholder="Search folders"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setChosen(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (chosen ?? results[0])) onPick((chosen ?? results[0])!)
            }}
          />
        </div>
        <ul className="picker-list" role="listbox" aria-label="Folders">
          {!results.length && <li className="thread-empty">No folders match.</li>}
          {results.map((folder) => (
            <li key={folder.id} role="option" aria-selected={chosen?.id === folder.id}>
              <button
                className={`picker-row${chosen?.id === folder.id ? ' chosen' : ''}`}
                title={folder.path}
                onClick={() => setChosen(folder)}
                onDoubleClick={() => onPick(folder)}
              >
                {folder.favorite ? <Star size={14} className="favorite-star" /> : <Folder size={14} />}
                <span>
                  <strong>{folder.name}</strong>
                  <small>{folder.path}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="form-actions">
          <button className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            {actionLabel}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
