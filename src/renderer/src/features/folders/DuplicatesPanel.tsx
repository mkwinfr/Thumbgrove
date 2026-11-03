import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Check, CopyCheck, Trash2 } from 'lucide-react'
import { thumbUrl, type DuplicateGroup, type DuplicateStatus } from '../../../../shared/api'
import { useLibraryStore } from './libraryStore'

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DuplicatesPanel() {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const [status, setStatus] = useState<DuplicateStatus | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const setImageAction = useLibraryStore((s) => s.setImageAction)
  const running = status?.phase === 'running'

  useEffect(() => {
    const load = (): void => {
      void window.thumbGrove.getDuplicates(null).then((list) => {
        setGroups(list)
        const present = new Set(list.flatMap((group) => group.images.map((image) => image.id)))
        setSelected((current) => current.filter((id) => present.has(id)))
      })
    }
    return window.thumbGrove.onLibraryEvent((event) => {
      if (event.type === 'duplicates') {
        setStatus(event.status)
        if (event.status.phase !== 'running') load()
      } else if (event.type === 'changed') {
        // Only refreshes a list that's already been asked for.
        setGroups((current) => {
          if (current) load()
          return current
        })
      }
    })
  }, [])

  const toggle = (id: number): void => setSelected((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]))
  const keepFirst = (): void => setSelected((groups ?? []).flatMap((group) => group.images.slice(1).map((image) => image.id)))
  const percent = status?.total ? (status.done / status.total) * 100 : 0

  return (
    <section className="card browse-main">
      <div className="upload-bar duplicate-bar">
        {running ? (
          <>
            <div className="upload-progress">
              <strong>
                Comparing {status.done.toLocaleString()} of {status.total.toLocaleString()} images
              </strong>
              <div className="queue-track upload-track" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
                <motion.div className="queue-fill" animate={{ width: `${percent}%` }} />
              </div>
            </div>
            <button className="button" onClick={() => void window.thumbGrove.cancelDuplicateScan()}>
              Stop
            </button>
          </>
        ) : (
          <>
            <div className="upload-summary">
              <strong>
                {groups === null ? 'Find identical images' : groups.length ? `${groups.length} ${groups.length === 1 ? 'set' : 'sets'} of duplicates` : 'No duplicates found'}
              </strong>
              <small>Only identical pictures count. Copies you made in separate character and set folders are left out.</small>
            </div>
            <div className="setting-root-actions">
              {selected.length > 0 && (
                <button className="button danger-solid" onClick={() => setImageAction({ kind: 'delete', ids: selected, name: null })}>
                  <Trash2 size={15} />
                  Delete {selected.length}
                </button>
              )}
              {Boolean(groups?.length) && (
                <button className="button" onClick={keepFirst}>
                  <CopyCheck size={15} />
                  Select all but the first
                </button>
              )}
              <button className="button primary" onClick={() => void window.thumbGrove.startDuplicateScan(null)}>
                {groups === null ? 'Find duplicates' : 'Check again'}
              </button>
            </div>
          </>
        )}
      </div>
      <div className="duplicate-list">
        {(groups ?? []).map((group) => (
          <div key={group.hash} className="duplicate-group">
            <h3>
              {group.width} × {group.height} · {group.images.length} copies
            </h3>
            <div className="duplicate-images">
              {group.images.map((image) => {
                const isSelected = selected.includes(image.id)
                return (
                  <button key={image.id} className={`duplicate-image${isSelected ? ' selected' : ''}`} aria-pressed={isSelected} title={`${image.folder}\\${image.name}`} onClick={() => toggle(image.id)}>
                    <span className="duplicate-thumb">
                      <img src={thumbUrl(image.id, image.mtimeMs)} alt="" loading="lazy" decoding="async" draggable={false} />
                      {isSelected && (
                        <span className="tile-check">
                          <Check size={13} strokeWidth={3} />
                        </span>
                      )}
                    </span>
                    <strong>{image.name}</strong>
                    <small>{image.folder.split('\\').slice(-2).join('\\')}</small>
                    <small>{formatSize(image.size)}</small>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
