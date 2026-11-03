import type { DragEvent } from 'react'
import type { FolderInfo } from '../../../../shared/api'
import { useLibraryStore, type MoveSubject } from './libraryStore'

/** A folder can't go inside itself, and there's no point dropping one where it already is. */
function canDrop(subject: MoveSubject | null, folder: FolderInfo): boolean {
  if (!subject) return false
  if (subject.kind === 'images') return true
  const moving = subject.folder
  if (moving.id === folder.id || moving.parentId === folder.id) return false
  return !`${folder.path.toLowerCase()}\\`.startsWith(`${moving.path.toLowerCase()}\\`)
}

/** Makes an element accept dragged images and folders, highlighting while one is held over it. */
export function dropProps(folder: FolderInfo) {
  return {
    onDragOver: (event: DragEvent) => {
      const store = useLibraryStore.getState()
      if (!canDrop(store.dragging, folder)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      if (store.dropFolderId !== folder.id) store.setDropFolder(folder.id)
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      const store = useLibraryStore.getState()
      if (store.dropFolderId === folder.id) store.setDropFolder(null)
    },
    onDrop: (event: DragEvent) => {
      const store = useLibraryStore.getState()
      const subject = store.dragging
      if (!subject || !canDrop(subject, folder)) return
      event.preventDefault()
      event.stopPropagation()
      store.setDragging(null)
      void store.moveTo(subject, folder)
    }
  }
}
