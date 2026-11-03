import { useCallback } from 'react'
import { BookImage, ClipboardCopy, EyeOff, FolderInput, FolderOpen, FolderPlus, FolderTree, Pencil, ScanSearch, Send, Star, Tags, Trash2 } from 'lucide-react'
import type { FolderInfo } from '../../../../shared/api'
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu'
import { useAppStore } from '../../store'
import { useLibraryStore } from './libraryStore'

function folderItems(folder: FolderInfo): ContextMenuItem[] {
  const library = useLibraryStore.getState()
  const { startScan } = useAppStore.getState()
  const action = (kind: 'rename' | 'delete' | 'untrack' | 'stop' | 'create') => () => library.setFolderAction({ kind, folder })
  const shared: ContextMenuItem[] = [
    { label: 'Scan folder', icon: ScanSearch, run: () => void startScan(folder.id, false) },
    ...(folder.hasChildren ? [{ label: 'Scan with subfolders', icon: FolderTree, run: () => void startScan(folder.id, true) }] : []),
    { label: 'New folder…', icon: FolderPlus, separatorBefore: true, run: action('create') },
    { label: folder.favorite ? 'Remove from favorites' : 'Add to favorites', icon: Star, run: () => void library.toggleFavorite(folder) },
    { label: 'Add tags…', icon: Tags, run: () => library.setTagTarget({ kind: 'folder', folder }) },
    { label: 'Add to catalogue…', icon: BookImage, run: () => library.setCatalogueTarget({ kind: 'folder', folder }) },
    { label: 'Add to Discord queue', icon: Send, run: () => void library.queueFolder(folder) }
  ]
  if (folder.parentId === null) {
    return [...shared, { label: 'Stop watching…', icon: EyeOff, separatorBefore: true, run: action('stop') }]
  }
  return [
    ...shared,
    { label: 'Rename…', icon: Pencil, separatorBefore: true, run: action('rename') },
    { label: 'Move…', icon: FolderInput, run: () => library.setMoveSubject({ kind: 'folder', folder }) },
    { label: 'Untrack…', icon: EyeOff, separatorBefore: true, run: action('untrack') },
    { label: 'Delete…', icon: Trash2, danger: true, run: action('delete') }
  ]
}

function imageItems(ids: number[], name: string | null): ContextMenuItem[] {
  const library = useLibraryStore.getState()
  const single = ids.length === 1
  const only = ids[0]!
  return [
    { label: single ? 'Rename…' : `Rename ${ids.length} images…`, icon: Pencil, run: () => library.setImageAction({ kind: 'rename', ids, name: single ? name : null }) },
    { label: single ? 'Move…' : `Move ${ids.length} images…`, icon: FolderInput, run: () => library.setMoveSubject({ kind: 'images', ids }) },
    { label: single ? 'Edit tags…' : 'Add tags…', icon: Tags, run: () => library.setTagTarget({ kind: 'images', ids }) },
    { label: 'Add to catalogue…', icon: BookImage, run: () => library.setCatalogueTarget({ kind: 'images', ids }) },
    { label: 'Add to Discord queue', icon: Send, run: () => void library.queueImages(ids) },
    ...(single
      ? [
          { label: 'Show in Explorer', icon: FolderOpen, separatorBefore: true, run: () => void window.thumbGrove.revealImage(only) },
          { label: 'Copy file path', icon: ClipboardCopy, run: () => void window.thumbGrove.copyImagePath(only) }
        ]
      : []),
    { label: single ? 'Delete…' : `Delete ${ids.length} images…`, icon: Trash2, danger: true, separatorBefore: true, run: () => library.setImageAction({ kind: 'delete', ids, name }) }
  ]
}

/** The right-click menu shared by the tree, folder tiles, and images. */
export function LibraryMenu() {
  const menu = useLibraryStore((s) => s.menu)
  const openMenu = useLibraryStore((s) => s.openMenu)
  const close = useCallback(() => openMenu(null), [openMenu])
  if (!menu) return null
  return menu.kind === 'folder' ? (
    <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${menu.folder.name}`} items={folderItems(menu.folder)} onClose={close} />
  ) : (
    <ContextMenu x={menu.x} y={menu.y} label="Image actions" items={imageItems(menu.ids, menu.name)} onClose={close} />
  )
}
