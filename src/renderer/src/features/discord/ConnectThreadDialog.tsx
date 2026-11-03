import { useEffect, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { Check } from 'lucide-react'
import { thumbUrl, type ThreadOption, type ThreadSetup } from '../../../../shared/api'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useDiscordStore } from './discordStore'

type Mode = 'create' | 'existing'

const MAX_TAGS = 5

/** Links a character or set to a thread, either a new one or one already on the server. */
export function ConnectThreadDialog() {
  const request = useDiscordStore((s) => s.connect)
  const close = useDiscordStore((s) => s.setConnect)
  const [mode, setMode] = useState<Mode>('create')
  const [name, setName] = useState('')
  const [photoId, setPhotoId] = useState<number | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [threadId, setThreadId] = useState('')
  const [setup, setSetup] = useState<ThreadSetup | null>(null)
  const [threads, setThreads] = useState<ThreadOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!request) return
    setMode('create')
    setName(request.name)
    setPhotoId(request.imageIds[0]?.id ?? null)
    setTags([])
    setThreadId('')
    setSetup(null)
    setThreads([])
    setError(null)
    window.thumbGrove.getDiscordThreadSetup(request.kind).then(setSetup, (failure: unknown) => setError(errorMessage(failure)))
    window.thumbGrove.getDiscordThreads(request.kind).then(setThreads, () => setThreads([]))
  }, [request])

  const needsPhoto = request?.kind === 'characters'
  const noPhotoAvailable = mode === 'create' && needsPhoto && !request?.imageIds.length
  const tagMissing = mode === 'create' && setup?.isForum && setup.requiresTag && !tags.length
  const canSubmit = !saving && name.trim().length > 0 && (mode === 'existing' ? Boolean(threadId) : Boolean(setup) && !noPhotoAvailable && !tagMissing && (!needsPhoto || photoId !== null))

  const toggleTag = (id: string): void => {
    setTags((current) => (current.includes(id) ? current.filter((t) => t !== id) : current.length < MAX_TAGS ? [...current, id] : current))
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!request || !canSubmit) return
    setSaving(true)
    setError(null)
    try {
      if (mode === 'create') {
        await window.thumbGrove.createDiscordThread(request.kind, name, tags, photoId)
      } else {
        await window.thumbGrove.linkDiscordThread(request.kind, name, threadId, threads.find((t) => t.id === threadId)?.name ?? null)
      }
      close(null)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={request !== null} title={request?.kind === 'sets' ? 'Connect a set thread' : 'Connect a character thread'} onClose={() => close(null)}>
      <form className="name-form" onSubmit={(event) => void submit(event)}>
        <div className="tabs connect-tabs" role="tablist" aria-label="Thread source">
          {(['create', 'existing'] as const).map((target) => (
            <button key={target} type="button" role="tab" aria-selected={mode === target} onClick={() => setMode(target)}>
              {mode === target && <motion.span layoutId="connect-tab" className="tab-active" />}
              <span>{target === 'create' ? 'Create new' : 'Use existing'}</span>
            </button>
          ))}
        </div>
        <label>
          {mode === 'create' ? 'Thread name' : 'Name in Thumb Grove'}
          <input className="input" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        </label>

        {mode === 'existing' ? (
          <label>
            Thread
            <select className="select field-select" value={threadId} onChange={(event) => setThreadId(event.target.value)}>
              <option value="">{threads.length ? 'Choose a thread' : 'No active threads found'}</option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            {needsPhoto && (
              <div className="form-group">
                <span>First image in the thread</span>
                {request?.imageIds.length ? (
                  <div className="photo-picker">
                    {request.imageIds.map(({ id, mtimeMs }) => (
                      <button key={id} type="button" aria-pressed={photoId === id} className={`photo-option${photoId === id ? ' chosen' : ''}`} onClick={() => setPhotoId(id)}>
                        <img src={thumbUrl(id, mtimeMs)} alt="" decoding="async" />
                        {photoId === id && (
                          <span className="queue-posted">
                            <Check size={11} strokeWidth={3} />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="form-note">Character threads start with an image, so create this one from the queue.</p>
                )}
              </div>
            )}
            {setup && setup.isForum && setup.tags.length > 0 && (
              <div className="form-group">
                <span>
                  Forum tags {setup.requiresTag ? '(at least one)' : '(optional)'}, up to {MAX_TAGS}
                </span>
                <div className="chips">
                  {setup.tags.map((tag) => {
                    const on = tags.includes(tag.id)
                    return (
                      <div key={tag.id} className={`chip${on ? ' on' : ''}`}>
                        <button type="button" className="chip-main tag-chip" aria-pressed={on} onClick={() => toggleTag(tag.id)}>
                          <span className="chip-check">{on && <Check size={13} strokeWidth={3} />}</span>
                          <span className="chip-name">{tag.name}</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
        {error && <p className="panel-warning model-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!canSubmit}>
            {saving ? 'Working…' : mode === 'create' ? 'Create thread' : 'Connect'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
