import { motion } from 'motion/react'
import { History, Inbox, MessagesSquare, Plug, Settings2, type LucideIcon } from 'lucide-react'
import { useAppStore } from '../../store'
import { ConnectThreadDialog } from './ConnectThreadDialog'
import { useDiscordStore, type DiscordTab } from './discordStore'
import { HistoryTab } from './HistoryTab'
import { QueueTab } from './QueueTab'
import { ThreadsTab } from './ThreadsTab'

const TABS: Array<{ tab: DiscordTab; label: string; icon: LucideIcon }> = [
  { tab: 'queue', label: 'Queue', icon: Inbox },
  { tab: 'threads', label: 'Threads', icon: MessagesSquare },
  { tab: 'history', label: 'History', icon: History }
]

function Connection() {
  const status = useDiscordStore((s) => s.status)
  const openSettings = useAppStore((s) => s.openSettings)
  const connected = status?.connected
  return (
    <button className="connection" title="Discord settings" onClick={() => openSettings('discord')}>
      <span className={`connection-dot${connected ? ' on' : ''}`} />
      {connected ? status.username : status?.error ? 'Connection problem' : 'Not connected'}
      <Settings2 size={15} />
    </button>
  )
}

function SetupPrompt() {
  const status = useDiscordStore((s) => s.status)
  const openSettings = useAppStore((s) => s.openSettings)
  if (!status || status.connected) return null
  return (
    <div className="banner discord-banner" role="status">
      <Plug size={15} />
      <span>{status.error ?? 'Connect your bot to create threads and post images.'}</span>
      <button className="button compact" onClick={() => openSettings('discord')}>
        Set up
      </button>
    </div>
  )
}

export function DiscordView() {
  const tab = useDiscordStore((s) => s.tab)
  const setTab = useDiscordStore((s) => s.setTab)
  const ready = useDiscordStore((s) => s.ready)
  if (!ready) return null

  return (
    <div className="browse">
      <header className="review-header browse-header">
        <div className="browse-title">
          <h1>Discord</h1>
          <div className="tabs" role="tablist" aria-label="Discord sections">
            {TABS.map(({ tab: target, label, icon: Icon }) => (
              <button key={target} role="tab" aria-selected={tab === target} onClick={() => setTab(target)}>
                {tab === target && <motion.span layoutId="discord-tab" className="tab-active" transition={{ type: 'spring', stiffness: 460, damping: 36 }} />}
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
        <Connection />
      </header>
      <SetupPrompt />
      <div className="discord-body">
        {tab === 'queue' ? <QueueTab /> : tab === 'threads' ? <ThreadsTab /> : <HistoryTab />}
      </div>
      <ConnectThreadDialog />
    </div>
  )
}
