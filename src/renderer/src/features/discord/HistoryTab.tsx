import { useState } from 'react'
import { ImageOff } from 'lucide-react'
import { thumbUrl } from '../../../../shared/api'
import { useDiscordStore } from './discordStore'

function formatTime(time: number): string {
  return time ? new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

export function HistoryTab() {
  const history = useDiscordStore((s) => s.history)
  const connected = useDiscordStore((s) => s.status?.connected)
  const deletePost = useDiscordStore((s) => s.deletePost)
  const [confirming, setConfirming] = useState<number | null>(null)

  if (!history.length) {
    return (
      <div className="placeholder">
        <h1>Nothing posted yet</h1>
        <p>Images you post appear here.</p>
      </div>
    )
  }

  return (
    <section className="card history">
      <ul className="thread-list">
        {history.map((entry) => (
          <li key={entry.id} className="thread-row history-row">
            <span className="history-thumb">
              {entry.imageId !== null ? (
                <img src={thumbUrl(entry.imageId, entry.imageVersion ?? 0)} alt="" loading="lazy" decoding="async" />
              ) : (
                <ImageOff size={16} />
              )}
            </span>
            <div className="thread-text">
              <strong title={entry.name}>{entry.name}</strong>
              <small>
                {entry.targetName}
                {entry.postedAt ? ` · ${formatTime(entry.postedAt)}` : ''}
              </small>
            </div>
            {confirming === entry.id ? (
              <div className="setting-root-actions">
                <button className="button compact" onClick={() => setConfirming(null)}>
                  Keep
                </button>
                <button
                  className="button compact danger-solid"
                  onClick={() => {
                    setConfirming(null)
                    void deletePost(entry.id)
                  }}
                >
                  Delete post
                </button>
              </div>
            ) : (
              <button
                className="button compact ghost thread-action"
                disabled={!connected}
                title="Deletes the post from Discord. The image on this computer stays."
                onClick={() => setConfirming(entry.id)}
              >
                Delete post
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
