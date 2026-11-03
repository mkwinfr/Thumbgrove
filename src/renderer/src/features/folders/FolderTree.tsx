import { memo, type DragEvent, type MouseEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, ChevronRight, Folder, FolderPlus, Star } from 'lucide-react'
import type { FolderInfo } from '../../../../shared/api'
import { dropProps } from './dragging'
import { useLibraryStore } from './libraryStore'

const NO_FOLDERS: FolderInfo[] = []

/** Lets a tree row take dragged images and folders, and be dragged itself. */
function dragProps(folder: FolderInfo, draggable: boolean) {
  return {
    draggable,
    onDragStart: (event: DragEvent) => {
      if (!draggable) return
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', folder.name)
      useLibraryStore.getState().setDragging({ kind: 'folder', folder })
    },
    onDragEnd: () => useLibraryStore.getState().setDragging(null),
    ...dropProps(folder)
  }
}

function openFolderMenu(event: MouseEvent, folder: FolderInfo): void {
  event.preventDefault()
  useLibraryStore.getState().openMenu({ kind: 'folder', folder, x: event.clientX, y: event.clientY })
}

const TreeNode = memo(function TreeNode({ folder, depth }: { folder: FolderInfo; depth: number }) {
  const isOpen = useLibraryStore((s) => Boolean(s.expanded[folder.id]))
  const isCurrent = useLibraryStore((s) => s.folderId === folder.id)
  const isDropTarget = useLibraryStore((s) => s.dropFolderId === folder.id)
  const children = useLibraryStore((s) => s.tree[String(folder.id)] ?? NO_FOLDERS)
  const toggle = useLibraryStore((s) => s.toggleTree)
  const open = useLibraryStore((s) => s.open)

  return (
    <li>
      <div
        className={`tree-row${isCurrent ? ' current' : ''}${isDropTarget ? ' drop-target' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onContextMenu={(event) => openFolderMenu(event, folder)}
        {...dragProps(folder, folder.parentId !== null)}
      >
        <button
          className={`tree-chevron${isOpen ? ' open' : ''}`}
          aria-label={isOpen ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
          style={{ visibility: folder.hasChildren ? 'visible' : 'hidden' }}
          onClick={() => void toggle(folder.id)}
        >
          <ChevronRight size={14} />
        </button>
        <button className="tree-name" title={folder.path} onClick={() => void open(folder.id)}>
          {folder.available ? <Folder size={15} /> : <AlertTriangle size={15} className="tree-warning" />}
          <span>{folder.name}</span>
          <small>{folder.totalCount.toLocaleString()}</small>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {isOpen && children.length > 0 && (
          <motion.ul
            className="tree-list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            {children.map((child) => (
              <TreeNode key={child.id} folder={child} depth={depth + 1} />
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </li>
  )
})

function Favorites() {
  const favorites = useLibraryStore((s) => s.favorites)
  const currentId = useLibraryStore((s) => s.folderId)
  const dropId = useLibraryStore((s) => s.dropFolderId)
  const open = useLibraryStore((s) => s.open)
  if (!favorites.length) return null
  return (
    <div className="tree-favorites">
      <h2>Favorites</h2>
      <ul className="tree-list">
        {favorites.map((folder) => (
          <li key={folder.id}>
            <div
              className={`tree-row favorite-row${currentId === folder.id ? ' current' : ''}${dropId === folder.id ? ' drop-target' : ''}`}
              onContextMenu={(event) => openFolderMenu(event, folder)}
              {...dropProps(folder)}
            >
              <button className="tree-name" title={folder.path} onClick={() => void open(folder.id)}>
                <Star size={14} className="favorite-star" />
                <span>{folder.name}</span>
                <small>{folder.totalCount.toLocaleString()}</small>
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function FolderTree() {
  const roots = useLibraryStore((s) => s.tree.null ?? NO_FOLDERS)
  const addRoot = useLibraryStore((s) => s.addRoot)
  return (
    <aside className="card tree" aria-label="Watched folders">
      <div className="tree-header">
        <h2>Watched</h2>
        <button className="icon-button small" aria-label="Watch another folder" title="Watch another folder" onClick={() => void addRoot()}>
          <FolderPlus size={15} />
        </button>
      </div>
      <div className="tree-scroll">
        <Favorites />
        <ul className="tree-list">
          {roots.map((root) => (
            <TreeNode key={root.id} folder={root} depth={0} />
          ))}
        </ul>
      </div>
    </aside>
  )
}
