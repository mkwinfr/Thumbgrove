import { useEffect } from 'react'
import { motion } from 'motion/react'
import { AlertTriangle, ChevronRight, CopyCheck, Grid2x2, Layers, ScanSearch, Search, UserRound, X, FolderTree as FolderTreeIcon, type LucideIcon } from 'lucide-react'
import { isRecognitionBusy, RecognitionPill } from '../../components/RecognitionPill'
import logo from '../../assets/logo.png'
import { useAppStore } from '../../store'
import { useLibraryStore, type BrowseMode } from './libraryStore'
import { FolderPicker } from '../../components/FolderPicker'
import { AddToCatalogueDialog } from '../catalogues/AddToCatalogueDialog'
import { DuplicatesPanel } from './DuplicatesPanel'
import { FolderActionDialog } from './FolderActionDialog'
import { FolderTree } from './FolderTree'
import { ImageActionDialog } from './ImageActionDialog'
import { LibraryMenu } from './LibraryMenu'
import { TagDialog } from './TagDialog'
import { LibraryGrid } from './LibraryGrid'
import { ImageViewer } from './ImageViewer'
import type { ImageSort } from '../../../../shared/api'

const MODES: Array<{ mode: BrowseMode; label: string; icon: LucideIcon }> = [
  { mode: 'folders', label: 'Folders', icon: FolderTreeIcon },
  { mode: 'sets', label: 'Sets', icon: Layers },
  { mode: 'characters', label: 'Characters', icon: UserRound },
  { mode: 'duplicates', label: 'Duplicates', icon: CopyCheck }
]

function Crumbs() {
  const crumbs = useLibraryStore((s) => s.crumbs)
  const mode = useLibraryStore((s) => s.mode)
  const modeRoot = useLibraryStore((s) => s.modeRoot)
  const open = useLibraryStore((s) => s.open)
  const search = useLibraryStore((s) => s.search.trim())
  const visible = mode === 'folders' || !modeRoot ? crumbs : crumbs.slice(crumbs.findIndex((c) => c.id === modeRoot.id))
  return (
    <nav className="crumbs" aria-label="Current folder">
      {mode === 'folders' && (
        <button className={visible.length ? '' : 'current'} onClick={() => void open(null)}>
          Watched folders
        </button>
      )}
      {visible.map((crumb, index) => (
        <span key={crumb.id} className="crumb">
          {(index > 0 || mode === 'folders') && <ChevronRight size={14} />}
          <button className={index === visible.length - 1 ? 'current' : ''} title={crumb.path} onClick={() => void open(crumb.id)}>
            {crumb.name}
          </button>
        </span>
      ))}
      {search && <span className="crumb-search">Results for “{search}”</span>}
    </nav>
  )
}

function ScanPill() {
  const scan = useLibraryStore((s) => s.scan)
  if (!scan.active) return null
  return (
    <motion.span className="scan-pill" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} title={`Checking ${scan.rootName}`}>
      <span className="scan-dot" />
      Checking {scan.filesSeen ? scan.filesSeen.toLocaleString() : ''} files
    </motion.span>
  )
}

function Toolbar() {
  const search = useLibraryStore((s) => s.search)
  const setSearch = useLibraryStore((s) => s.setSearch)
  const sort = useLibraryStore((s) => s.sort)
  const setSort = useLibraryStore((s) => s.setSort)
  const includeSubfolders = useLibraryStore((s) => s.includeSubfolders)
  const setIncludeSubfolders = useLibraryStore((s) => s.setIncludeSubfolders)
  const folderId = useLibraryStore((s) => s.folderId)
  return (
    <div className="browse-tools">
      <div className="search-field">
        <Search size={15} />
        <input
          className="input"
          aria-label="Search by filename, tag, or folder name"
          title="Searches filenames, tags, and folder names"
          placeholder="Search names and tags"
          spellCheck={false}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearch('')
          }}
        />
        {search && (
          <button className="icon-button small" aria-label="Clear search" onClick={() => setSearch('')}>
            <X size={14} />
          </button>
        )}
      </div>
      <label className="check-field" title="Also show images from folders inside this one">
        <input
          type="checkbox"
          disabled={folderId === null}
          checked={includeSubfolders}
          onChange={(event) => setIncludeSubfolders(event.target.checked)}
        />
        Subfolders
      </label>
      <TileSizeSlider />
      <select className="select" aria-label="Sort images" value={sort} onChange={(event) => setSort(event.target.value as ImageSort)}>
        <option value="name">Name</option>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="largest">Largest</option>
      </select>
    </div>
  )
}

/** Thumbnail size. Follows the slider at once and saves when it's released. */
function TileSizeSlider() {
  const tileSize = useAppStore((s) => s.settings.tileSize)
  const update = useAppStore((s) => s.updateSettings)
  return (
    <label className="tile-slider" title="Thumbnail size">
      <Grid2x2 size={15} />
      <input type="range" aria-label="Thumbnail size" min={110} max={340} step={10} value={tileSize} onChange={(event) => void update({ tileSize: Number(event.target.value) })} />
    </label>
  )
}

function MoveDialog() {
  const subject = useLibraryStore((s) => s.moveSubject)
  const close = useLibraryStore((s) => s.setMoveSubject)
  const moveTo = useLibraryStore((s) => s.moveTo)
  const title = subject?.kind === 'folder' ? `Move ${subject.folder.name}` : subject?.ids.length === 1 ? 'Move image' : `Move ${subject?.ids.length ?? 0} images`
  return (
    <FolderPicker
      open={subject !== null}
      title={title}
      actionLabel="Move here"
      onClose={() => close(null)}
      onPick={(folder) => {
        if (subject) void moveTo(subject, folder)
        close(null)
      }}
    />
  )
}

function ModeTabs() {
  const mode = useLibraryStore((s) => s.mode)
  const setMode = useLibraryStore((s) => s.setMode)
  return (
    <div className="tabs" role="tablist" aria-label="Browse by">
      {MODES.map(({ mode: target, label, icon: Icon }) => (
        <button key={target} role="tab" aria-selected={mode === target} onClick={() => void setMode(target)}>
          {mode === target && <motion.span layoutId="browse-tab" className="tab-active" transition={{ type: 'spring', stiffness: 460, damping: 36 }} />}
          <Icon size={15} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}

function ScanButton() {
  const folderId = useLibraryStore((s) => s.folderId)
  const includeSubfolders = useLibraryStore((s) => s.includeSubfolders)
  const busy = useAppStore((s) => isRecognitionBusy(s.recognition?.phase))
  const startScan = useAppStore((s) => s.startScan)
  if (folderId === null) return null
  return (
    <button
      className="button compact primary"
      disabled={busy}
      title={includeSubfolders ? 'Find characters in up to 200 images here and in subfolders' : 'Find characters in up to 200 images directly in this folder'}
      onClick={() => void startScan(folderId, includeSubfolders)}
    >
      <ScanSearch size={15} />
      {includeSubfolders ? 'Scan with subfolders' : 'Scan folder'}
    </button>
  )
}

/** With images selected, this takes the place of the scan button. */
function SelectionBar() {
  const selected = useLibraryStore((s) => s.selected)
  const clearSelection = useLibraryStore((s) => s.clearSelection)
  const openMenu = useLibraryStore((s) => s.openMenu)
  if (!selected.length) return <ScanButton />
  return (
    <div className="selection-bar">
      <strong>{selected.length.toLocaleString()} selected</strong>
      <button
        className="button compact primary"
        onClick={(event) => {
          const { left, bottom } = event.currentTarget.getBoundingClientRect()
          // Waits a tick, so the click that opened the menu doesn't also close it.
          setTimeout(() => openMenu({ kind: 'images', ids: selected, name: null, x: left, y: bottom + 6 }))
        }}
      >
        Actions
      </button>
      <button className="button compact ghost" onClick={clearSelection}>
        Clear
      </button>
    </div>
  )
}

/** Ctrl+A selects everything listed, Esc clears the selection, and Delete asks to delete it. */
function useSelectionShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const store = useLibraryStore.getState()
      const target = event.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || store.viewer || document.querySelector('.dialog, .context-menu')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        void store.selectAllImages()
      } else if (event.key === 'Escape') {
        store.clearSelection()
      } else if (event.key === 'Delete' && store.selected.length) {
        store.setImageAction({ kind: 'delete', ids: store.selected, name: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function FirstRun() {
  const addRoot = useLibraryStore((s) => s.addRoot)
  return (
    <div className="placeholder">
      <img className="welcome-logo" src={logo} alt="" draggable={false} />
      <p className="welcome-name">
        Thumb Grove
        <small>Your images. Neatly Rooted</small>
      </p>
      <h1>Watch your first folder</h1>
      <p>Your images stay where they are. Thumb Grove indexes them and keeps up with changes.</p>
      <button className="button primary" onClick={() => void addRoot()}>
        Choose a folder
      </button>
    </div>
  )
}

function UnwatchedDestination({ path, label }: { path: string; label: string }) {
  const addRootPath = useLibraryStore((s) => s.addRootPath)
  const openSettings = useAppStore((s) => s.openSettings)
  return (
    <div className="placeholder">
      <h1>{label} folder isn't being watched</h1>
      <p className="placeholder-path">{path}</p>
      <div className="placeholder-actions">
        <button className="button primary" onClick={() => void addRootPath(path)}>
          Watch this folder
        </button>
        <button className="button" onClick={() => openSettings('folders')}>
          Change in Settings
        </button>
      </div>
    </div>
  )
}

export function FoldersView() {
  const ready = useLibraryStore((s) => s.ready)
  const hasRoots = useLibraryStore((s) => s.roots.length > 0)
  const mode = useLibraryStore((s) => s.mode)
  const modeRoot = useLibraryStore((s) => s.modeRoot)
  const error = useLibraryStore((s) => s.error)
  const clearError = useLibraryStore((s) => s.clearError)
  const roots = useAppStore((s) => s.roots)
  useSelectionShortcuts()

  if (!ready) return null

  const destination = mode === 'sets' ? roots.sets : roots.characters
  const showGrid = hasRoots && (mode === 'folders' || modeRoot)

  return (
    <div className="browse">
      <header className="review-header browse-header">
        <div className="browse-title">
          <h1>{MODES.find((m) => m.mode === mode)?.label}</h1>
          <ModeTabs />
          <ScanPill />
          <RecognitionPill />
        </div>
        {showGrid && mode !== 'duplicates' && <Toolbar />}
      </header>
      {error && (
        <div className="banner" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button className="icon-button small" aria-label="Dismiss" onClick={clearError}>
            <X size={14} />
          </button>
        </div>
      )}
      {!hasRoots ? (
        <FirstRun />
      ) : mode === 'duplicates' ? (
        <DuplicatesPanel />
      ) : !showGrid ? (
        <UnwatchedDestination path={destination} label={mode === 'sets' ? 'Your Sets' : 'Your Characters'} />
      ) : (
        <div className={`browse-body${mode === 'folders' ? ' with-tree' : ''}`}>
          {mode === 'folders' && <FolderTree />}
          <section className="card browse-main">
            <div className="browse-bar">
              <Crumbs />
              <SelectionBar />
            </div>
            <LibraryGrid />
          </section>
        </div>
      )}
      <ImageViewer />
      <LibraryMenu />
      <MoveDialog />
      <AddToCatalogueDialog />
      <FolderActionDialog />
      <ImageActionDialog />
      <TagDialog />
    </div>
  )
}
