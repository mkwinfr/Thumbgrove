import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { FolderOpen, Layers, Merge, Pencil, Search, Send, UsersRound, X } from 'lucide-react'
import type { CharacterEntry } from '../../../../shared/api'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'
import { useLibraryStore } from '../folders/libraryStore'
import { SetsPanel } from './SetsPanel'

function MergeDialog({ from, characters, onClose }: { from: CharacterEntry | null; characters: CharacterEntry[]; onClose(): void }) {
  const notify = useAppStore((s) => s.notify)
  const [query, setQuery] = useState('')
  const [into, setInto] = useState<CharacterEntry | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setQuery('')
    setInto(null)
    setError(null)
    setWorking(false)
  }, [from])

  const options = characters.filter((c) => c.key !== from?.key && c.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 40)

  const merge = async (): Promise<void> => {
    if (!from || !into) return
    setWorking(true)
    try {
      const { moved, failed } = await window.thumbGrove.mergeCharacters(from.raw, into.raw)
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
        <p className="dialog-text">
          Choose the character to keep. Images in this character's folder move into theirs, tags and thread links carry over, and files with the same name get a number added. This has no undo.
        </p>
        <div className="search-field picker-search">
          <Search size={15} />
          <input className="input" autoFocus aria-label="Search characters" placeholder="Search characters" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <ul className="picker-list" role="listbox" aria-label="Characters">
          {!options.length && <li className="thread-empty">No other characters match.</li>}
          {options.map((character) => (
            <li key={character.key} role="option" aria-selected={into?.key === character.key}>
              <button className={`picker-row${into?.key === character.key ? ' chosen' : ''}`} onClick={() => setInto(character)}>
                <span>
                  <strong>{character.name}</strong>
                  <small>
                    {character.series || 'No series'} · {character.imageCount.toLocaleString()} images
                  </small>
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

export function CharactersView() {
  const [characters, setCharacters] = useState<CharacterEntry[]>([])
  const [query, setQuery] = useState('')
  const [merging, setMerging] = useState<CharacterEntry | null>(null)
  const [tab, setTab] = useState<'characters' | 'sets'>('characters')
  const edit = useAppStore((s) => s.setEditingCharacter)
  const setView = useAppStore((s) => s.setView)

  useEffect(() => {
    const load = (): void => void window.thumbGrove.getCharacters().then(setCharacters)
    load()
    return window.thumbGrove.onLibraryEvent((event) => {
      if (event.type === 'changed' || event.type === 'reviews') load()
    })
  }, [])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? characters.filter((c) => c.name.toLowerCase().includes(needle) || c.series.toLowerCase().includes(needle)) : characters
  }, [characters, query])

  const openFolder = (id: number): void => {
    setView('folders')
    void useLibraryStore.getState().setMode('folders').then(() => useLibraryStore.getState().open(id))
  }

  return (
    <div className="browse">
      <header className="review-header browse-header">
        <div className="browse-title">
          <h1>{tab === 'sets' ? 'Sets' : 'Characters'}</h1>
          <div className="tabs" role="tablist" aria-label="Show">
            {(['characters', 'sets'] as const).map((target) => {
              const Icon = target === 'sets' ? Layers : UsersRound
              return (
                <button key={target} role="tab" aria-selected={tab === target} onClick={() => setTab(target)}>
                  {tab === target && <motion.span layoutId="names-tab" className="tab-active" transition={{ type: 'spring', stiffness: 460, damping: 36 }} />}
                  <Icon size={15} />
                  <span>{target === 'sets' ? 'Sets' : 'Characters'}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="browse-tools">
          <div className="search-field">
            <Search size={15} />
            <input className="input" aria-label="Search characters" placeholder={tab === 'sets' ? 'Search sets' : 'Search names and series'} spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} />
            {query && (
              <button className="icon-button small" aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      </header>
      {tab === 'sets' ? <SetsPanel query={query} /> : (
      <section className="card history">
        {!visible.length ? (
          <div className="grid-empty-static">{query ? `No characters match “${query}”.` : 'Characters appear here once you have a Characters folder or review images.'}</div>
        ) : (
          <ul className="thread-list">
            <li className="character-head" aria-hidden="true">
              <span>Name</span>
              <span>Series</span>
              <span>Images</span>
              <span />
            </li>
            {visible.map((character) => (
              <li key={character.key} className="character-row">
                <strong title={character.raw}>{character.name}</strong>
                <span className="character-series">{character.series || <em>None</em>}</span>
                <span className="character-count">
                  {character.imageCount.toLocaleString()}
                  {character.threadId && (
                    <span title="Connected to a Discord thread">
                      <Send size={12} />
                    </span>
                  )}
                </span>
                <span className="character-actions">
                  {character.folderId !== null && (
                    <button className="icon-button small" aria-label={`Open ${character.name}'s folder`} title="Open folder" onClick={() => openFolder(character.folderId!)}>
                      <FolderOpen size={15} />
                    </button>
                  )}
                  <button className="icon-button small" aria-label={`Merge ${character.name}`} title="Merge into another character" onClick={() => setMerging(character)}>
                    <Merge size={15} />
                  </button>
                  <button className="icon-button small" aria-label={`Edit ${character.name}`} title="Edit name and series" onClick={() => edit(character.raw)}>
                    <Pencil size={15} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}
      <MergeDialog from={merging} characters={characters} onClose={() => setMerging(null)} />
    </div>
  )
}
