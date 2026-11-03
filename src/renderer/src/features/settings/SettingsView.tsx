import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { AlertTriangle, EyeOff, FolderTree, Info, ScanSearch, Send, X, type LucideIcon } from 'lucide-react'
import type { AppInfo, Correction, Settings, UpdateStatus } from '../../../../shared/api'
import { displayName } from '../../../../shared/naming'
import { Dialog } from '../../components/Dialog'
import { FolderPicker } from '../../components/FolderPicker'
import { Toggle } from '../../components/Toggle'
import logo from '../../assets/logo.png'
import { useAppStore, type SettingsSection } from '../../store'
import { DiscordSettings } from '../discord/DiscordSettings'
import { applySettings, useLibraryStore } from '../folders/libraryStore'

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: LucideIcon }> = [
  { id: 'folders', label: 'Folders', icon: FolderTree },
  { id: 'review', label: 'Review', icon: ScanSearch },
  { id: 'discord', label: 'Discord', icon: Send },
  { id: 'about', label: 'About', icon: Info }
]

function formatDate(time: number | null): string {
  return time ? new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not checked yet'
}

function Row({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
      {children}
    </div>
  )
}

function ToggleRow({ title, text, setting }: { title: string; text: string; setting: keyof Settings }) {
  const value = useAppStore((s) => s.settings[setting]) as boolean
  const update = useAppStore((s) => s.updateSettings)
  return (
    <Row title={title} text={text}>
      <Toggle checked={value} label={title} onChange={(on) => void update({ [setting]: on })} />
    </Row>
  )
}

function PercentRow({ title, text, setting, min }: { title: string; text: string; setting: 'autoApproveThreshold' | 'preselectThreshold'; min: number }) {
  const value = useAppStore((s) => s.settings[setting])
  const update = useAppStore((s) => s.updateSettings)
  const [draft, setDraft] = useState(Math.round(value * 100))
  useEffect(() => setDraft(Math.round(value * 100)), [value])
  return (
    <Row title={title} text={text}>
      <div className="setting-slider">
        <input
          type="range"
          aria-label={title}
          min={min}
          max={100}
          value={draft}
          onChange={(event) => setDraft(Number(event.target.value))}
          onPointerUp={() => void update({ [setting]: draft / 100 })}
          onKeyUp={() => void update({ [setting]: draft / 100 })}
        />
        <span>{draft}%</span>
      </div>
    </Row>
  )
}

/** Saves each valid number as it's typed, and goes back to the saved value if left on an invalid one. */
function NumberRow({ title, text, setting, min, max }: { title: string; text: string; setting: 'queueLimit' | 'uploadLimitMb'; min: number; max: number }) {
  const value = useAppStore((s) => s.settings[setting])
  const update = useAppStore((s) => s.updateSettings)
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return (
    <Row title={title} text={text}>
      <input
        className="input queue-limit-input"
        type="number"
        aria-label={title}
        min={min}
        max={max}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          const next = Number(event.target.value)
          if (event.target.value !== '' && Number.isInteger(next) && next >= min && next <= max) void update({ [setting]: next })
        }}
        onBlur={() => setDraft(String(value))}
      />
    </Row>
  )
}

function WatchedFolders() {
  const roots = useLibraryStore((s) => s.roots)
  const untracked = useLibraryStore((s) => s.untracked)
  const retrack = useLibraryStore((s) => s.retrack)
  const addRoot = useLibraryStore((s) => s.addRoot)
  const removeRoot = useLibraryStore((s) => s.removeRoot)
  const rescan = useLibraryStore((s) => s.rescan)
  const scanning = useLibraryStore((s) => s.scan.active)
  const error = useLibraryStore((s) => s.error)
  const clearError = useLibraryStore((s) => s.clearError)
  const [confirming, setConfirming] = useState<number | null>(null)

  return (
    <div className="settings-group">
      <h3>Watched folders</h3>
      {error && (
        <p className="panel-warning setting-error" role="alert" onClick={clearError}>
          <AlertTriangle size={14} /> {error}
        </p>
      )}
      {!roots.length && <p className="setting-empty">No folders yet. Add one to start browsing.</p>}
      {roots.map((root) => (
        <div key={root.id} className="setting-path setting-root">
          <div className="setting-root-text">
            <strong>
              {!root.available && <AlertTriangle size={13} className="tree-warning" />} {root.name}
            </strong>
            <code>{root.path}</code>
            {confirming === root.id ? (
              <small>Thumb Grove will forget these images. The files on disk stay untouched.</small>
            ) : (
              <small>{root.available ? `${root.imageCount.toLocaleString()} images · ${formatDate(root.lastScanAt)}` : 'Not available. Is the drive connected?'}</small>
            )}
          </div>
          {confirming === root.id ? (
            <div className="setting-root-actions">
              <button className="button compact" onClick={() => setConfirming(null)}>
                Keep
              </button>
              <button
                className="button compact danger-solid"
                onClick={() => {
                  setConfirming(null)
                  void removeRoot(root.id)
                }}
              >
                Stop watching
              </button>
            </div>
          ) : (
            <button className="button compact" onClick={() => setConfirming(root.id)}>
              Remove
            </button>
          )}
        </div>
      ))}
      {untracked.map((folder) => (
        <div key={folder.path} className="setting-path setting-root">
          <div className="setting-root-text">
            <strong>
              <EyeOff size={13} className="setting-untracked-icon" /> Untracked
            </strong>
            <code>{folder.path}</code>
          </div>
          <button className="button compact" onClick={() => void retrack(folder.path)}>
            Track again
          </button>
        </div>
      ))}
      <div className="setting-buttons">
        <button className="button compact" onClick={() => void addRoot()}>
          Add folder
        </button>
        <button className="button compact" disabled={scanning || !roots.length} onClick={() => void rescan()}>
          {scanning ? 'Checking…' : 'Check for changes'}
        </button>
      </div>
    </div>
  )
}

function FoldersSection() {
  const roots = useAppStore((s) => s.roots)
  const hydrateSettings = useAppStore((s) => s.hydrateSettings)
  const tileSize = useAppStore((s) => s.settings.tileSize)
  const update = useAppStore((s) => s.updateSettings)
  const choose = async (kind: 'characters' | 'sets'): Promise<void> => {
    const next = await window.thumbGrove.chooseDestination(kind)
    hydrateSettings(next)
    await applySettings(next)
  }

  return (
    <>
      <WatchedFolders />
      <div className="settings-group">
        <h3>Destination folders</h3>
        <div className="setting-path setting-root">
          <div className="setting-root-text">
            <strong>Characters</strong>
            <code>{roots.characters}</code>
          </div>
          <button className="button compact" onClick={() => void choose('characters')}>
            Change
          </button>
        </div>
        <div className="setting-path setting-root">
          <div className="setting-root-text">
            <strong>Sets</strong>
            <code>{roots.sets}</code>
          </div>
          <button className="button compact" onClick={() => void choose('sets')}>
            Change
          </button>
        </div>
      </div>
      <div className="settings-group">
        <h3>Browsing</h3>
        <Row title="Thumbnail size" text="How large images and folders appear in grids. There's also a slider on the Folders page.">
          <div className="setting-slider">
            <input type="range" aria-label="Thumbnail size" min={110} max={340} step={10} value={tileSize} onChange={(event) => void update({ tileSize: Number(event.target.value) })} />
            <span>{tileSize}</span>
          </div>
        </Row>
      </div>
    </>
  )
}

function LearnedCorrections() {
  const [items, setItems] = useState<Correction[]>([])
  const load = (): void => void window.thumbGrove.getCorrections().then(setItems)
  useEffect(load, [])
  if (!items.length) return null
  return (
    <div className="setting-path">
      <strong>Learned so far</strong>
      <ul className="learned-list">
        {items.map((item) => (
          <li key={`${item.suggested}|${item.chosen}`}>
            <span title={`Chosen instead ${item.times} times`}>
              {displayName(item.suggested)} → <strong>{displayName(item.chosen)}</strong>
            </span>
            <button
              className="icon-button small"
              aria-label={`Forget ${displayName(item.chosen)}`}
              title="Forget this"
              onClick={() => void window.thumbGrove.forgetCorrection(item.suggested, item.chosen).then(load)}
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function updateText(status: UpdateStatus | null): string {
  switch (status?.phase) {
    case 'checking':
      return 'Checking for updates.'
    case 'current':
      return 'You have the latest version.'
    case 'downloading':
      return `Downloading version ${status.version}. ${status.percent}% done.`
    case 'ready':
      return `Version ${status.version} is ready. It installs when you restart or next close Thumb Grove.`
    case 'error':
      return status.error ?? ''
    case 'unavailable':
      return 'This copy does not update itself. Get new versions from the Releases page.'
    default:
      return 'Updates download in the background.'
  }
}

function UpdateRow() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void window.thumbGrove.getUpdateStatus().then(setStatus)
    return window.thumbGrove.onUpdateStatus(setStatus)
  }, [])
  return (
    <Row title="Updates" text={updateText(status)}>
      {status?.phase === 'ready' ? (
        <button className="button compact primary" onClick={() => void window.thumbGrove.installUpdate()}>
          Restart to update
        </button>
      ) : status && status.phase !== 'unavailable' ? (
        <button className="button compact" disabled={status.phase === 'checking' || status.phase === 'downloading'} onClick={() => void window.thumbGrove.checkForUpdates()}>
          Check now
        </button>
      ) : (
        <span />
      )}
    </Row>
  )
}

function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => void window.thumbGrove.getAppInfo().then(setInfo), [])
  return (
    <div className="settings-group">
      <div className="about-brand">
        <img src={logo} alt="" draggable={false} />
        <span>
          <strong>Thumb Grove</strong>
          <small>Your images. Neatly Rooted</small>
        </span>
      </div>
      <Row title={`Version ${info?.version ?? ''}`} text="Thumb Grove only uses the internet for Discord, app updates, and the first download of the recognition model.">
        <span />
      </Row>
      <UpdateRow />
      <div className="setting-path setting-root">
        <div className="setting-root-text">
          <strong>Thumb Grove's data</strong>
          <code>{info?.dataFolder}</code>
          <small>
            Your index, tags, and thread links. {info?.backups ?? 0} automatic {info?.backups === 1 ? 'backup' : 'backups'} from before upgrades.
          </small>
        </div>
        <button className="button compact" onClick={() => void window.thumbGrove.openDataFolder()}>
          Open
        </button>
      </div>
      <div className="setting-path setting-root">
        <div className="setting-root-text">
          <strong>Error log</strong>
          <small>Useful when something goes wrong. It never contains your bot token.</small>
        </div>
        <button className="button compact" onClick={() => void window.thumbGrove.openLogFolder()}>
          Open
        </button>
      </div>
    </div>
  )
}

function ReviewSection() {
  const autoScanFolder = useAppStore((s) => s.settings.autoScanFolder)
  const autoScanEnabled = useAppStore((s) => s.settings.autoScanEnabled)
  const update = useAppStore((s) => s.updateSettings)
  const [picking, setPicking] = useState(false)

  return (
    <>
      <div className="settings-group">
        <h3>Scanning</h3>
        <ToggleRow title="Scan new images automatically" text="When images arrive in the folder below, Thumb Grove scans them and adds them to the review queue." setting="autoScanEnabled" />
        <div className="setting-path setting-root">
          <div className="setting-root-text">
            <strong>Folder to scan automatically</strong>
            <code>{autoScanFolder || 'None chosen'}</code>
            {autoScanEnabled && !autoScanFolder && <small className="setting-attention">Choose a folder to turn this on.</small>}
          </div>
          <div className="setting-root-actions">
            {autoScanFolder && (
              <button className="button compact" onClick={() => void update({ autoScanFolder: '' })}>
                Clear
              </button>
            )}
            <button className="button compact" onClick={() => setPicking(true)}>
              {autoScanFolder ? 'Change' : 'Choose'}
            </button>
          </div>
        </div>
        <ToggleRow title="Include its subfolders" text="Also scan folders inside the chosen folder." setting="autoScanSubfolders" />
        <NumberRow title="Review queue limit" text="Each scan fills the queue up to this many images, from 1 to 500." setting="queueLimit" min={1} max={500} />
      </div>
      <div className="settings-group">
        <h3>Auto-approve</h3>
        <ToggleRow
          title="Auto-approve high-confidence matches"
          text="An image with one suggested character at or above this confidence skips review and goes straight to its character folder."
          setting="autoApprove"
        />
        <PercentRow title="Auto-approve confidence" text="Higher is safer. Lower approves more images without you seeing them." setting="autoApproveThreshold" min={50} />
      </div>
      <div className="settings-group">
        <h3>Reviewing</h3>
        <PercentRow title="Tick suggestions from" text="Suggested characters at or above this confidence start ticked. Images already in the queue keep their choices." setting="preselectThreshold" min={10} />
        <ToggleRow title="Place in character folders by default" text="The starting position of this toggle for each new image." setting="defaultPlaceInCharacters" />
        <ToggleRow title="Place in the set folder by default" text="Whether choosing a set also puts a copy in that set's folder." setting="defaultPlaceInSet" />
        <ToggleRow title="Learn from my corrections" text="After you replace the same suggestion with the same character twice, Thumb Grove suggests your choice instead. It doesn't auto-approve these." setting="learnCorrections" />
        <LearnedCorrections />
        <ToggleRow title="Carry the set to the next image" text="After you apply an image with a set, the next image starts with that set. Useful when working through one set." setting="carrySet" />
      </div>
      <FolderPicker
        open={picking}
        title="Folder to scan automatically"
        actionLabel="Use this folder"
        onClose={() => setPicking(false)}
        onPick={(folder) => {
          setPicking(false)
          void update({ autoScanFolder: folder.path })
        }}
      />
    </>
  )
}

function DiscordSection() {
  return (
    <>
      <div className="settings-group">
        <h3>Connection</h3>
        <DiscordSettings />
      </div>
      <div className="settings-group">
        <h3>Uploading</h3>
        <ToggleRow title="Check Discord before uploading" text="Reads the destination threads first and skips images already there. Turn this off for faster uploads to threads you know are clear." setting="checkBeforeUpload" />
        <NumberRow title="Upload limit in MB" text="Images over this are flagged instead of failing partway. 0 follows your server's boost level: 10 MB, or 50 and 100 MB at levels 2 and 3." setting="uploadLimitMb" min={0} max={1000} />
      </div>
    </>
  )
}

export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const section = useAppStore((s) => s.settingsSection)
  const setSection = useAppStore((s) => s.setSettingsSection)
  const close = useCallback(() => setOpen(false), [setOpen])
  return (
    <Dialog open={open} title="Settings" onClose={close} className="settings-dialog">
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={section === id} onClick={() => setSection(id)}>
            {section === id && <motion.span layoutId="settings-tab" className="tab-active" transition={{ type: 'spring', stiffness: 460, damping: 36 }} />}
            <Icon size={15} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="settings-page">
        <div className="settings-column">
          {section === 'folders' ? <FoldersSection /> : section === 'review' ? <ReviewSection /> : section === 'discord' ? <DiscordSection /> : <AboutSection />}
        </div>
      </div>
    </Dialog>
  )
}
