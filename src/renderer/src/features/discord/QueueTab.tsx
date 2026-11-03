import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { AlertTriangle, Check, CheckCheck, Layers, Link2, ListX, SearchCheck, Send, UserRound, X } from 'lucide-react'
import { thumbUrl, type QueueEntry, type ThreadKind } from '../../../../shared/api'
import { BulkConnectDialog, type MissingThread } from './BulkConnectDialog'
import { useDiscordStore } from './discordStore'

const MAX_THUMBS = 36

interface Group {
  key: string
  kind: ThreadKind | null
  title: string
  subtitle: string
  missing: boolean
  entries: QueueEntry[]
}

/** Groups by where images are still going. An image with several destinations appears under each. */
function buildGroups(queue: QueueEntry[]): Group[] {
  const groups = new Map<string, Group>()
  const add = (key: string, base: Omit<Group, 'key' | 'entries'>, entry: QueueEntry): void => {
    const group = groups.get(key) ?? { key, ...base, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }
  for (const entry of queue) {
    for (const target of entry.targets.filter((t) => !t.posted)) {
      add(`thread:${target.threadId}`, { kind: target.kind, title: target.name, subtitle: target.threadName ?? '', missing: false }, entry)
    }
    for (const item of entry.missing) {
      add(`missing:${item.kind}:${item.name.toLowerCase()}`, { kind: item.kind, title: item.name, subtitle: 'No thread yet', missing: true }, entry)
    }
    if (!entry.targets.length && !entry.missing.length) {
      add('none', { kind: null, title: 'No destination', subtitle: 'These images have no character or set', missing: true }, entry)
    }
  }
  return [...groups.values()].sort((a, b) => Number(b.missing) - Number(a.missing) || a.title.localeCompare(b.title))
}

/** Ready when it can go to at least one connected thread. A missing thread only holds back that thread. */
function isReady(entry: QueueEntry): boolean {
  return entry.targets.some((target) => !target.posted) && !entry.tooLarge
}

function QueueThumb({ entry }: { entry: QueueEntry }) {
  const remove = useDiscordStore((s) => s.removeFromQueue)
  const toggleSelected = useDiscordStore((s) => s.toggleSelected)
  const isSelected = useDiscordStore((s) => s.selected.includes(entry.id))
  return (
    <div
      className={`queue-thumb${entry.lastError || entry.tooLarge ? ' failed' : ''}${isSelected ? ' selected' : ''}`}
      title={entry.tooLarge ? `${entry.name} is too large for this server` : (entry.lastError ?? entry.name)}
    >
      <button className="queue-select" aria-label={`Select ${entry.name}`} aria-pressed={isSelected} onClick={() => toggleSelected(entry.id)}>
        <img src={thumbUrl(entry.id, entry.mtimeMs)} alt="" loading="lazy" decoding="async" draggable={false} />
      </button>
      {isSelected && (
        <span className="tile-check queue-check">
          <Check size={11} strokeWidth={3} />
        </span>
      )}
      <button className="queue-remove" aria-label={`Remove ${entry.name} from the queue`} title="Remove from the queue" onClick={() => void remove([entry.id])}>
        <X size={12} />
      </button>
    </div>
  )
}

function GroupCard({ group, busy }: { group: Group; busy: boolean }) {
  const startUpload = useDiscordStore((s) => s.startUpload)
  const setConnect = useDiscordStore((s) => s.setConnect)
  const connected = useDiscordStore((s) => s.status?.connected)
  const remove = useDiscordStore((s) => s.removeFromQueue)
  const selectMany = useDiscordStore((s) => s.selectMany)
  const ready = group.entries.filter((entry) => !entry.tooLarge)
  const errors = [...new Set(group.entries.flatMap((entry) => entry.lastError ?? []))]
  const threadId = group.key.startsWith('thread:') ? group.key.slice(7) : null
  const Icon = group.kind === 'sets' ? Layers : group.kind === 'characters' ? UserRound : AlertTriangle

  return (
    <motion.section layout="position" className={`card queue-group${group.missing ? ' needs-thread' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <header className="queue-group-header">
        <div className="queue-group-title">
          <Icon size={16} />
          <div>
            <h2>{group.title}</h2>
            <small>
              {group.entries.length} {group.entries.length === 1 ? 'image' : 'images'}
              {group.subtitle && group.subtitle !== group.title ? ` · ${group.subtitle}` : ''}
            </small>
          </div>
        </div>
        <div className="queue-group-actions">
          <button
            className="icon-button"
            aria-label={`Select all in ${group.title}`}
            title="Select all in this group"
            onClick={() => selectMany(group.entries.map((entry) => entry.id))}
          >
            <CheckCheck size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={`Remove all in ${group.title} from the queue`}
            title="Remove this group from the queue. An image going to several threads leaves all of them. Files aren't changed."
            onClick={() => void remove(group.entries.map((entry) => entry.id))}
          >
            <ListX size={16} />
          </button>
          {group.missing && group.kind ? (
            <button
              className="button compact primary"
              disabled={!connected}
              onClick={() =>
                setConnect({
                  kind: group.kind!,
                  name: group.title,
                  imageIds: group.entries.slice(0, 12).map((entry) => ({ id: entry.id, mtimeMs: entry.mtimeMs }))
                })
              }
            >
              <Link2 size={14} />
              Connect thread
            </button>
          ) : !group.missing ? (
            <button
              className="button compact"
              disabled={busy || !connected || !ready.length}
              title="Posts these images to this thread only, up to 10 in each message"
              onClick={() => void startUpload(ready.map((entry) => entry.id), threadId ?? undefined)}
            >
              <Send size={14} />
              Upload
            </button>
          ) : null}
        </div>
      </header>
      {errors.map((error) => (
        <p key={error} className="panel-warning queue-error">
          <AlertTriangle size={14} /> {error}
        </p>
      ))}
      <div className="queue-thumbs">
        {group.entries.slice(0, MAX_THUMBS).map((entry) => (
          <QueueThumb key={entry.id} entry={entry} />
        ))}
        {group.entries.length > MAX_THUMBS && <div className="queue-more">+{group.entries.length - MAX_THUMBS}</div>}
      </div>
    </motion.section>
  )
}

function UploadBar({ ready, busy, missing, setBulkOpen }: { ready: number[]; busy: boolean; missing: MissingThread[]; setBulkOpen(open: boolean): void }) {
  const upload = useDiscordStore((s) => s.upload)
  const startUpload = useDiscordStore((s) => s.startUpload)
  const connected = useDiscordStore((s) => s.status?.connected)
  const queueSize = useDiscordStore((s) => s.queue.length)
  const startCheck = useDiscordStore((s) => s.startCheck)
  const tooLarge = useDiscordStore((s) => s.queue.filter((entry) => entry.tooLarge).length)
  const limit = useDiscordStore((s) => s.status?.uploadLimitBytes ?? 0)
  const selected = useDiscordStore((s) => s.selected)
  const removeFromQueue = useDiscordStore((s) => s.removeFromQueue)
  const clearSelected = useDiscordStore((s) => s.clearSelected)
  const [confirming, setConfirming] = useState(false)

  if (busy && upload) {
    const percent = upload.total ? (upload.done / upload.total) * 100 : 0
    return (
      <div className="card upload-bar">
        <div className="upload-progress">
          <strong>
            {upload.phase === 'cancelling'
              ? 'Stopping'
              : upload.phase === 'checking'
                ? 'Checking what is already on Discord'
                : `Posting ${Math.min(upload.done + 1, upload.total)} of ${upload.total}`}
          </strong>
          <small>{upload.name}</small>
          <div className="queue-track upload-track" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
            <motion.div className="queue-fill" animate={{ width: `${percent}%` }} />
          </div>
        </div>
        <button className="button" disabled={upload.phase === 'cancelling'} onClick={() => void window.thumbGrove.cancelDiscordUpload()}>
          Stop
        </button>
      </div>
    )
  }

  if (selected.length) {
    return (
      <div className="card upload-bar">
        <div className="upload-summary">
          <strong>{selected.length} selected</strong>
          <small>Removing only affects the queue. Files and Discord posts aren't changed.</small>
        </div>
        <div className="setting-root-actions">
          <button className="button" onClick={clearSelected}>
            Clear
          </button>
          <button className="button danger-solid" onClick={() => void removeFromQueue(selected)}>
            Remove {selected.length} from queue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card upload-bar">
      <div className="upload-summary">
        <strong>{ready.length === queueSize ? `${queueSize} ready to post` : `${ready.length} of ${queueSize} ready to post`}</strong>
        <small className={tooLarge ? 'queue-size-warning' : undefined}>
          {tooLarge
            ? `${tooLarge} ${tooLarge === 1 ? 'is' : 'are'} over this server's ${Math.round(limit / (1024 * 1024))} MB limit.`
            : ready.length < queueSize
              ? 'The rest only need threads that are not connected yet.'
              : 'Failed images stay here so you can retry them.'}
        </small>
      </div>
      {confirming ? (
        <div className="setting-root-actions">
          <button className="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button
            className="button primary"
            onClick={() => {
              setConfirming(false)
              void startUpload(ready)
            }}
          >
            Post {ready.length} to connected threads
          </button>
        </div>
      ) : (
        <div className="setting-root-actions">
          {missing.length > 1 && (
            <button className="button" disabled={!connected} onClick={() => setBulkOpen(true)}>
              <Link2 size={15} />
              Connect {missing.length} threads
            </button>
          )}
          <button
            className="button"
            disabled={!connected || !ready.length}
            title="Removes queued images that are already in their threads. Posts nothing."
            onClick={() => void startCheck()}
          >
            <SearchCheck size={15} />
            Check Discord
          </button>
          <button className="button primary" disabled={!connected || !ready.length} onClick={() => setConfirming(true)}>
            <Send size={15} />
            Upload all
          </button>
        </div>
      )}
    </div>
  )
}

export function QueueTab() {
  const queue = useDiscordStore((s) => s.queue)
  const phase = useDiscordStore((s) => s.upload?.phase)
  const groups = useMemo(() => buildGroups(queue), [queue])
  const ready = useMemo(() => queue.filter(isReady).map((entry) => entry.id), [queue])
  const busy = phase === 'checking' || phase === 'running' || phase === 'cancelling'
  const [bulkOpen, setBulkOpen] = useState(false)
  const missing = useMemo<MissingThread[]>(
    () =>
      groups.flatMap((group) => (group.missing && group.kind ? [{ kind: group.kind, name: group.title, photoId: group.entries[0]?.id ?? null }] : [])),
    [groups]
  )

  if (!queue.length) {
    return (
      <div className="placeholder">
        <div className="rings" aria-hidden="true">
          <span />
          <span />
          <span />
          <div className="rings-core">
            <Send size={26} strokeWidth={1.6} />
          </div>
        </div>
        <h1>The queue is empty</h1>
        <p>Use the send button when applying in Review, or right-click images or a folder in Folders and choose Add to Discord queue.</p>
      </div>
    )
  }

  return (
    <div className="queue-layout">
      <UploadBar ready={ready} busy={busy} missing={missing} setBulkOpen={setBulkOpen} />
      <BulkConnectDialog missing={missing} open={bulkOpen} onClose={() => setBulkOpen(false)} />
      <div className="queue-groups">
        {groups.map((group) => (
          <GroupCard key={group.key} group={group} busy={busy} />
        ))}
      </div>
    </div>
  )
}
