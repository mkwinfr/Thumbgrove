import { useState } from 'react'
import { Layers, Plus, UserRound } from 'lucide-react'
import type { ThreadKind } from '../../../../shared/api'
import { useDiscordStore } from './discordStore'

function ThreadColumn({ kind, title }: { kind: ThreadKind; title: string }) {
  const links = useDiscordStore((s) => s.links)
  const channel = useDiscordStore((s) => s.status?.config.parents[kind])
  const connected = useDiscordStore((s) => s.status?.connected)
  const setConnect = useDiscordStore((s) => s.setConnect)
  const unlink = useDiscordStore((s) => s.unlink)
  const [confirming, setConfirming] = useState<string | null>(null)
  const rows = links.filter((link) => link.kind === kind)
  const Icon = kind === 'sets' ? Layers : UserRound

  return (
    <section className="card thread-column">
      <header className="tree-header">
        <h2>
          <Icon size={14} /> {title} <span>{rows.length}</span>
        </h2>
        <button
          className="icon-button small"
          aria-label={`Connect a ${kind === 'sets' ? 'set' : 'character'} thread`}
          title={channel ? 'Connect a thread' : 'Choose a channel in Discord settings first'}
          disabled={!connected || !channel}
          onClick={() => setConnect({ kind, name: '', imageIds: [] })}
        >
          <Plus size={15} />
        </button>
      </header>
      <ul className="thread-list">
        {!rows.length && <li className="thread-empty">No threads connected yet.</li>}
        {rows.map((link) => (
          <li key={link.name} className="thread-row">
            <div className="thread-text">
              <strong>{link.name}</strong>
              <small>{link.threadName && link.threadName !== link.name ? link.threadName : `Thread ${link.threadId.slice(-6)}`}</small>
            </div>
            {confirming === link.name ? (
              <div className="setting-root-actions">
                <button className="button compact" onClick={() => setConfirming(null)}>
                  Keep
                </button>
                <button
                  className="button compact danger-solid"
                  title="Thumb Grove forgets this link. The thread stays on Discord."
                  onClick={() => {
                    setConfirming(null)
                    void unlink(kind, link.name)
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button className="button compact ghost thread-action" onClick={() => setConfirming(link.name)}>
                Disconnect
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ThreadsTab() {
  return (
    <div className="thread-columns">
      <ThreadColumn kind="characters" title="Characters" />
      <ThreadColumn kind="sets" title="Sets" />
    </div>
  )
}
