import { useEffect, useState } from 'react'
import { Check, Layers, UserRound } from 'lucide-react'
import type { ThreadKind, ThreadSetup } from '../../../../shared/api'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'

export interface MissingThread {
  kind: ThreadKind
  name: string
  /** The first queued image, which starts a character thread. */
  photoId: number | null
}

const MAX_TAGS = 5

/**
 * Connects many threads at once. A thread already on the server with the same name is linked instead
 * of creating a second one.
 */
export function BulkConnectDialog({ missing, open, onClose }: { missing: MissingThread[]; open: boolean; onClose(): void }) {
  const notify = useAppStore((s) => s.notify)
  const [chosen, setChosen] = useState<string[]>([])
  const [setups, setSetups] = useState<Partial<Record<ThreadKind, ThreadSetup>>>({})
  const [tags, setTags] = useState<Record<ThreadKind, string[]>>({ characters: [], sets: [] })
  const [progress, setProgress] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const keyOf = (item: MissingThread): string => `${item.kind}:${item.name}`
  const kinds = [...new Set(missing.map((item) => item.kind))]

  useEffect(() => {
    if (!open) return
    setChosen(missing.map(keyOf))
    setTags({ characters: [], sets: [] })
    setProgress(null)
    setErrors([])
    for (const kind of kinds) {
      window.thumbGrove.getDiscordThreadSetup(kind).then(
        (setup) => setSetups((current) => ({ ...current, [kind]: setup })),
        (failure: unknown) => setErrors((current) => [...current, errorMessage(failure)])
      )
    }
    // Fills the form each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggleTag = (kind: ThreadKind, id: string): void =>
    setTags((current) => {
      const list = current[kind]
      return { ...current, [kind]: list.includes(id) ? list.filter((tag) => tag !== id) : list.length < MAX_TAGS ? [...list, id] : list }
    })

  const needsTag = kinds.some((kind) => setups[kind]?.isForum && setups[kind]?.requiresTag && !tags[kind].length && missing.some((item) => item.kind === kind && chosen.includes(keyOf(item))))
  const blocked = missing.some((item) => item.kind === 'characters' && item.photoId === null && chosen.includes(keyOf(item)))

  const run = async (): Promise<void> => {
    const queue = missing.filter((item) => chosen.includes(keyOf(item)))
    const failures: string[] = []
    const existing: Partial<Record<ThreadKind, Map<string, { id: string; name: string }>>> = {}
    for (const kind of kinds) {
      const threads = await window.thumbGrove.getDiscordThreads(kind).catch(() => [])
      existing[kind] = new Map(threads.map((thread) => [thread.name.toLowerCase(), thread]))
    }
    let linked = 0
    let created = 0
    for (const [index, item] of queue.entries()) {
      setProgress(`Connecting ${index + 1} of ${queue.length}: ${item.name}`)
      try {
        const match = existing[item.kind]?.get(item.name.toLowerCase())
        if (match) {
          await window.thumbGrove.linkDiscordThread(item.kind, item.name, match.id, match.name)
          linked++
        } else {
          await window.thumbGrove.createDiscordThread(item.kind, item.name, tags[item.kind], item.photoId)
          created++
        }
      } catch (failure) {
        failures.push(`${item.name}: ${errorMessage(failure)}`)
      }
    }
    setProgress(null)
    if (failures.length) setErrors(failures)
    else onClose()
    if (created || linked) notify(`Created ${created} ${created === 1 ? 'thread' : 'threads'} and linked ${linked} existing`)
  }

  return (
    <Dialog open={open} title="Connect threads" onClose={onClose}>
      <div className="picker">
        <p className="dialog-text">Threads already on your server with the same name are linked. The rest are created, and character threads start with the first queued image.</p>
        <ul className="picker-list" aria-label="Threads to connect">
          {missing.map((item) => {
            const on = chosen.includes(keyOf(item))
            const Icon = item.kind === 'sets' ? Layers : UserRound
            return (
              <li key={keyOf(item)}>
                <button
                  className={`picker-row${on ? ' chosen' : ''}`}
                  aria-pressed={on}
                  onClick={() => setChosen((current) => (on ? current.filter((key) => key !== keyOf(item)) : [...current, keyOf(item)]))}
                >
                  {on ? <Check size={14} /> : <Icon size={14} />}
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.kind === 'sets' ? 'Set' : 'Character'}</small>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {kinds.map((kind) => {
          const setup = setups[kind]
          if (!setup?.isForum || !setup.tags.length) return null
          return (
            <div key={kind} className="form-group">
              <span>
                Forum tags for {kind === 'sets' ? 'set' : 'character'} threads {setup.requiresTag ? '(at least one)' : '(optional)'}
              </span>
              <div className="chips">
                {setup.tags.map((tag) => {
                  const on = tags[kind].includes(tag.id)
                  return (
                    <div key={tag.id} className={`chip${on ? ' on' : ''}`}>
                      <button type="button" className="chip-main tag-chip" aria-pressed={on} onClick={() => toggleTag(kind, tag.id)}>
                        <span className="chip-check">{on && <Check size={13} strokeWidth={3} />}</span>
                        <span className="chip-name">{tag.name}</span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {progress && <p className="form-note">{progress}</p>}
        {errors.map((error) => (
          <p key={error} className="panel-warning model-error">
            {error}
          </p>
        ))}
        <div className="form-actions">
          <button className="button ghost" onClick={onClose}>
            Close
          </button>
          <button className="button primary" disabled={!chosen.length || needsTag || blocked || progress !== null} onClick={() => void run()}>
            Connect {chosen.length}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
