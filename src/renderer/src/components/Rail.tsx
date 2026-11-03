import { AnimatePresence, motion } from 'motion/react'
import { BookImage, FolderTree, ScanSearch, Send, Settings, UsersRound, type LucideIcon } from 'lucide-react'
import logo from '../assets/logo.png'
import { useAppStore } from '../store'
import type { ViewName } from '../types'

const ITEMS: Array<{ view: ViewName; label: string; icon: LucideIcon }> = [
  { view: 'folders', label: 'Folders', icon: FolderTree },
  { view: 'review', label: 'Review', icon: ScanSearch },
  { view: 'characters', label: 'Characters', icon: UsersRound },
  { view: 'discord', label: 'Discord', icon: Send },
  { view: 'catalogues', label: 'Catalogues', icon: BookImage }
]

export function Rail() {
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const reviewCount = useAppStore((s) => s.queue.length)
  const discordCount = useAppStore((s) => s.discordQueued)
  const counts: Partial<Record<ViewName, number>> = { review: reviewCount, discord: discordCount }

  return (
    <nav className="rail" aria-label="Main">
      <div className="brand" aria-label="Thumb Grove">
        <img className="brand-mark" src={logo} alt="" draggable={false} />
      </div>
      <div className="rail-items">
        {ITEMS.map(({ view: target, label, icon: Icon }) => {
          const active = view === target
          const count = counts[target] ?? 0
          return (
            <button
              key={target}
              id={`nav-${target}`}
              className={`rail-item${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => setView(target)}
            >
              {active && (
                <motion.span
                  layoutId="rail-active"
                  className="rail-active"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="rail-icon">
                <Icon size={20} strokeWidth={1.8} />
                <AnimatePresence initial={false}>
                  {count > 0 && (
                    <motion.span
                      key={count}
                      className="rail-count"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 520, damping: 22 }}
                    >
                      {count}
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
              <span className="rail-label">{label}</span>
            </button>
          )
        })}
      </div>
      <button id="nav-settings" className="rail-item rail-settings" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
        <span className="rail-icon">
          <Settings size={20} strokeWidth={1.8} />
        </span>
        <span className="rail-label">Settings</span>
      </button>
    </nav>
  )
}
