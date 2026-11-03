import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Folder, ImageOff, Star } from 'lucide-react'
import { thumbUrl, type FolderInfo, type ImageInfo } from '../../../../shared/api'
import { useAppStore } from '../../store'
import { dropProps } from './dragging'
import { imageAt, useLibraryStore } from './libraryStore'

const GAP = 12
const PADDING = 14
const TILE_RATIO = 1.28

/** Fades in from a blur when loaded, and shows a quiet placeholder if the image can't be read. */
function Thumbnail({ id, version }: { id: number; version: number }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  useEffect(() => setState('loading'), [id, version])
  if (state === 'failed') {
    return (
      <span className="tile-fallback">
        <ImageOff size={22} />
      </span>
    )
  }
  return (
    <img
      className={`tile-image${state === 'loaded' ? ' loaded' : ''}`}
      src={thumbUrl(id, version)}
      alt=""
      decoding="async"
      draggable={false}
      onLoad={() => setState('loaded')}
      onError={() => setState('failed')}
    />
  )
}

const FolderTile = memo(function FolderTile({ folder }: { folder: FolderInfo }) {
  const open = useLibraryStore((s) => s.open)
  const openMenu = useLibraryStore((s) => s.openMenu)
  const isDropTarget = useLibraryStore((s) => s.dropFolderId === folder.id)
  return (
    <button
      className={`tile folder-tile${isDropTarget ? ' drop-target' : ''}`}
      title={folder.path}
      draggable={folder.parentId !== null}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', folder.name)
        useLibraryStore.getState().setDragging({ kind: 'folder', folder })
      }}
      onDragEnd={() => useLibraryStore.getState().setDragging(null)}
      {...dropProps(folder)}
      onClick={() => void open(folder.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        openMenu({ kind: 'folder', folder, x: event.clientX, y: event.clientY })
      }}
    >
      {folder.favorite && (
        <span className="tile-favorite" title="Favorite">
          <Star size={13} />
        </span>
      )}
      {folder.coverId !== null ? (
        <Thumbnail id={folder.coverId} version={folder.coverVersion} />
      ) : (
        <span className="tile-fallback">
          <Folder size={26} strokeWidth={1.5} />
        </span>
      )}
      <span className="folder-caption">
        <strong>{folder.name}</strong>
        <small>
          {folder.totalCount.toLocaleString()} {folder.totalCount === 1 ? 'image' : 'images'}
        </small>
      </span>
    </button>
  )
})

const ImageTile = memo(function ImageTile({ image, index }: { image: ImageInfo; index: number }) {
  const openViewer = useLibraryStore((s) => s.openViewer)
  const isSelected = useLibraryStore((s) => s.selected.includes(image.id))
  const onClick = (event: MouseEvent<HTMLButtonElement>): void => {
    const store = useLibraryStore.getState()
    if (event.shiftKey) {
      void store.selectRangeTo(index)
      return
    }
    if (event.ctrlKey || event.metaKey) {
      store.toggleImage(image.id, index)
      return
    }
    store.clearSelection()
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect()
    openViewer(index, { x: left, y: top, width, height })
  }
  return (
    <button
      className={`tile image-tile${isSelected ? ' selected' : ''}`}
      aria-label={image.name}
      aria-pressed={isSelected}
      title={image.name}
      draggable
      onDragStart={(event) => {
        const store = useLibraryStore.getState()
        // Dragging inside a selection moves all of it. Anywhere else moves just this image.
        const ids = store.selected.includes(image.id) ? store.selected : [image.id]
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', image.name)
        store.setDragging({ kind: 'images', ids })
      }}
      onDragEnd={() => useLibraryStore.getState().setDragging(null)}
      onClick={onClick}
      onContextMenu={(event) => {
        event.preventDefault()
        const store = useLibraryStore.getState()
        // Right-clicking inside a selection acts on all of it. Anywhere else picks just this image.
        const inSelection = store.selected.includes(image.id)
        if (!inSelection) store.clearSelection()
        const ids = inSelection ? store.selected : [image.id]
        store.openMenu({ kind: 'images', ids, name: ids.length === 1 ? image.name : null, x: event.clientX, y: event.clientY })
      }}
    >
      <Thumbnail id={image.id} version={image.mtimeMs} />
      {isSelected && (
        <span className="tile-check">
          <Check size={13} strokeWidth={3} />
        </span>
      )}
      <span className="image-caption">{image.name}</span>
    </button>
  )
})

function GridEmpty() {
  const folderId = useLibraryStore((s) => s.folderId)
  const search = useLibraryStore((s) => s.search.trim())
  return (
    <div className="grid-empty">
      {search ? `No images match “${search}”.` : folderId === null ? 'No folders yet.' : 'This folder has no images.'}
    </div>
  )
}

/**
 * One scrolling grid of subfolders followed by images. Only rows near the visible area exist in the
 * page and only nearby pages of results are loaded, so a folder of any size stays fast.
 */
export function LibraryGrid() {
  const children = useLibraryStore((s) => s.children)
  const total = useLibraryStore((s) => s.total)
  const pages = useLibraryStore((s) => s.pages)
  const scrollKey = useLibraryStore((s) => s.scrollKey)
  const listVersion = useLibraryStore((s) => s.listVersion)
  const ensureRange = useLibraryStore((s) => s.ensureRange)

  const tileSize = useAppStore((s) => s.settings.tileSize)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const inner = Math.max(0, width - PADDING * 2)
  const columns = Math.max(1, Math.floor((inner + GAP) / (tileSize + GAP)))
  const tileWidth = (inner - GAP * (columns - 1)) / columns
  const rowHeight = Math.round(tileWidth * TILE_RATIO) + GAP
  const itemCount = children.length + total
  const rowCount = Math.ceil(itemCount / columns)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
    paddingStart: PADDING,
    paddingEnd: PADDING
  })

  useEffect(() => virtualizer.measure(), [virtualizer, rowHeight])
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [scrollKey])

  const rows = virtualizer.getVirtualItems()
  const firstRow = rows[0]?.index ?? 0
  const lastRow = rows[rows.length - 1]?.index ?? 0

  useEffect(() => {
    const first = firstRow * columns - children.length
    const last = (lastRow + 1) * columns - children.length - 1
    if (last >= 0) ensureRange(first, last)
  }, [firstRow, lastRow, columns, children.length, listVersion, ensureRange])

  return (
    <div className="grid-scroll" ref={scrollRef}>
      {width > 0 && itemCount === 0 && <GridEmpty />}
      {width > 0 && (
        <div className="grid-sizer" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid-row"
              style={{
                height: rowHeight - GAP,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                transform: `translateY(${row.start}px)`
              }}
            >
              {Array.from({ length: columns }, (_, column) => {
                const index = row.index * columns + column
                if (index >= itemCount) return null
                const folder = children[index]
                if (folder) return <FolderTile key={`f${folder.id}`} folder={folder} />
                const imageIndex = index - children.length
                const image = imageAt({ pages }, imageIndex)
                return image ? (
                  <ImageTile key={`i${image.id}`} image={image} index={imageIndex} />
                ) : (
                  <div key={`p${index}`} className="tile tile-pending" />
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
