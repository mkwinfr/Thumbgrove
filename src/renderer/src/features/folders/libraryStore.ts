import { create } from 'zustand'
import type { ApplyOutcome, EnqueueResult, FolderInfo, ImageInfo, ImageSort, RootInfo, ScanStatus, Settings, UntrackedFolder } from '../../../../shared/api'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'

export type BrowseMode = 'folders' | 'sets' | 'characters' | 'duplicates'

const PAGE_SIZE = 200
const IDLE_SCAN: ScanStatus = { active: false, rootName: '', filesSeen: 0 }

export interface ViewerState {
  index: number
  /** Where the image opened from, so it can grow out of its tile. */
  origin: { x: number; y: number; width: number; height: number } | null
}

export interface FolderAction {
  kind: 'rename' | 'delete' | 'untrack' | 'stop' | 'create'
  folder: FolderInfo
}

export interface ImageAction {
  kind: 'rename' | 'delete'
  ids: number[]
  /** Current filename, when one image is being renamed. */
  name: string | null
}

export type TagTarget = { kind: 'images'; ids: number[] } | { kind: 'folder'; folder: FolderInfo }

/** What's being moved, by the folder picker or by dragging. */
export type MoveSubject = { kind: 'images'; ids: number[] } | { kind: 'folder'; folder: FolderInfo }

export type CatalogueTarget = { kind: 'images'; ids: number[] } | { kind: 'folder'; folder: FolderInfo }

export type LibraryMenu =
  | { kind: 'folder'; folder: FolderInfo; x: number; y: number }
  | { kind: 'images'; ids: number[]; name: string | null; x: number; y: number }

interface LibraryState {
  ready: boolean
  roots: RootInfo[]
  scan: ScanStatus
  error: string | null

  mode: BrowseMode
  /** Null shows the watched folders themselves. */
  folderId: number | null
  crumbs: FolderInfo[]
  /** Set and Character views open at this folder. Null means it isn't being watched. */
  modeRoot: FolderInfo | null
  children: FolderInfo[]
  search: string
  sort: ImageSort
  includeSubfolders: boolean

  total: number
  pages: Record<number, ImageInfo[]>
  /** Changes when the list changes, so that late responses from an old list are ignored. */
  listVersion: number
  /** Changes only when moving to a different list, so the grid knows to return to the top. */
  scrollKey: number

  tree: Record<string, FolderInfo[]>
  expanded: Record<number, boolean>
  viewer: ViewerState | null
  untracked: UntrackedFolder[]
  favorites: FolderInfo[]
  folderAction: FolderAction | null
  imageAction: ImageAction | null
  tagTarget: TagTarget | null
  menu: LibraryMenu | null
  moveSubject: MoveSubject | null
  catalogueTarget: CatalogueTarget | null
  dragging: MoveSubject | null
  dropFolderId: number | null
  /** Images picked with Ctrl-click, Shift-click, or Ctrl+A. */
  selected: number[]
  selectionAnchor: number | null

  setFolderAction(action: FolderAction | null): void
  setImageAction(action: ImageAction | null): void
  setTagTarget(target: TagTarget | null): void
  setMoveSubject(subject: MoveSubject | null): void
  setCatalogueTarget(target: CatalogueTarget | null): void
  setDragging(subject: MoveSubject | null): void
  setDropFolder(id: number | null): void
  moveTo(subject: MoveSubject, destination: FolderInfo): Promise<void>
  openMenu(menu: LibraryMenu | null): void
  toggleImage(id: number, index: number): void
  selectRangeTo(index: number): Promise<void>
  selectAllImages(): Promise<void>
  clearSelection(): void
  queueImages(ids: number[]): Promise<void>
  queueFolder(folder: FolderInfo): Promise<void>
  finishImages(outcome: ApplyOutcome, verb: string): void
  toggleFavorite(folder: FolderInfo): Promise<void>
  retrack(path: string): Promise<void>
  init(settings: Settings): Promise<void>
  setMode(mode: BrowseMode): Promise<void>
  open(folderId: number | null): Promise<void>
  setSearch(search: string): void
  setSort(sort: ImageSort): void
  setIncludeSubfolders(on: boolean): void
  ensureRange(first: number, last: number): void
  toggleTree(folderId: number): Promise<void>
  addRoot(): Promise<void>
  addRootPath(path: string): Promise<void>
  removeRoot(id: number): Promise<void>
  rescan(): Promise<void>
  openViewer(index: number, origin: ViewerState['origin']): void
  closeViewer(): void
  stepViewer(delta: number): void
  clearError(): void
}

function treeKey(parentId: number | null): string {
  return String(parentId)
}


const inFlight = new Set<string>()
let settings: Settings | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null

function reportQueued({ queued, unknown, alreadyPosted }: EnqueueResult): void {
  const { notify, setAlreadyPosted } = useAppStore.getState()
  if (alreadyPosted) setAlreadyPosted({ count: alreadyPosted, queued })
  else if (queued) notify(`Added ${queued} to the Discord queue`)
  if (unknown) notify(`${unknown} ${unknown === 1 ? 'image is' : 'images are'} not in a character or set folder, so ${unknown === 1 ? 'it' : 'they'} can't be queued.`, 'error')
}

export const useLibraryStore = create<LibraryState>((set, get) => {
  const query = (offset: number) => {
    const { folderId, search, sort, includeSubfolders } = get()
    return { folderId, search, sort, includeSubfolders, offset, limit: PAGE_SIZE }
  }

  const fetchPage = async (page: number): Promise<void> => {
    const version = get().listVersion
    const key = `${version}:${page}`
    if (inFlight.has(key) || get().pages[page]) return
    inFlight.add(key)
    try {
      // Without a folder or a search there's nothing to list except the watched folders.
      const { folderId, search } = get()
      const result = folderId === null && !search.trim() ? { total: 0, items: [] } : await window.thumbGrove.listImages(query(page * PAGE_SIZE))
      if (get().listVersion !== version) return
      set((s) => ({ total: result.total, pages: { ...s.pages, [page]: result.items } }))
    } finally {
      inFlight.delete(key)
    }
  }

  /** Reloads the current list. Keeps the scroll position unless this is a different list. */
  const reload = async (resetScroll: boolean): Promise<void> => {
    const { folderId, mode, search } = get()
    const [children, crumbs] = await Promise.all([
      search.trim() ? Promise.resolve([]) : window.thumbGrove.getChildren(folderId),
      folderId === null ? Promise.resolve([]) : window.thumbGrove.getAncestors(folderId)
    ])
    // A folder that disappeared while open sends the view back to the start of this section.
    if (folderId !== null && !crumbs.length) {
      const fallback = mode === 'folders' ? null : (get().modeRoot?.id ?? null)
      if (fallback !== folderId) {
        set({ folderId: fallback })
        return reload(true)
      }
    }
    set((s) => ({
      children,
      crumbs,
      pages: {},
      listVersion: s.listVersion + 1,
      scrollKey: resetScroll ? s.scrollKey + 1 : s.scrollKey,
      viewer: resetScroll ? null : s.viewer,
      selected: resetScroll ? [] : s.selected,
      selectionAnchor: resetScroll ? null : s.selectionAnchor
    }))
    await fetchPage(0)
  }

  const loadModeRoot = async (): Promise<FolderInfo | null> => {
    const { mode } = get()
    if (mode === 'folders' || mode === 'duplicates' || !settings) return null
    return window.thumbGrove.getFolderByPath(mode === 'sets' ? settings.setsRoot : settings.charactersRoot)
  }

  const refreshTree = async (): Promise<void> => {
    const expandedIds = Object.entries(get().expanded).filter(([, on]) => on).map(([id]) => Number(id))
    const parents = [null, ...expandedIds]
    const lists = await Promise.all(parents.map((id) => window.thumbGrove.getChildren(id)))
    set({ tree: Object.fromEntries(parents.map((id, i) => [treeKey(id), lists[i]!])) })
  }

  const refreshAll = async (): Promise<void> => {
    const [roots, modeRoot, untracked, favorites] = await Promise.all([
      window.thumbGrove.getRoots(),
      loadModeRoot(),
      window.thumbGrove.getUntracked(),
      window.thumbGrove.getFavorites()
    ])
    set({ roots, modeRoot, untracked, favorites })
    // The Sets or Characters folder can appear partway through a scan.
    if ((get().mode === 'sets' || get().mode === 'characters') && get().folderId === null && modeRoot) set({ folderId: modeRoot.id })
    await refreshTree()
    await reload(false)
  }

  return {
    ready: false,
    roots: [],
    scan: IDLE_SCAN,
    error: null,
    mode: 'folders',
    folderId: null,
    crumbs: [],
    modeRoot: null,
    children: [],
    search: '',
    sort: 'name',
    includeSubfolders: false,
    total: 0,
    pages: {},
    listVersion: 0,
    scrollKey: 0,
    tree: {},
    expanded: {},
    viewer: null,
    untracked: [],
    favorites: [],
    folderAction: null,
    imageAction: null,
    tagTarget: null,
    menu: null,
    moveSubject: null,
    catalogueTarget: null,
    dragging: null,
    dropFolderId: null,
    selected: [],
    selectionAnchor: null,

    setFolderAction: (folderAction) => set({ folderAction }),
    setImageAction: (imageAction) => set({ imageAction }),
    setTagTarget: (tagTarget) => set({ tagTarget }),
    setMoveSubject: (moveSubject) => set({ moveSubject }),
    setCatalogueTarget: (catalogueTarget) => set({ catalogueTarget }),
    setDragging: (dragging) => set({ dragging, dropFolderId: null }),
    setDropFolder: (dropFolderId) => set({ dropFolderId }),

    moveTo: async (subject, destination) => {
      const { notify } = useAppStore.getState()
      try {
        if (subject.kind === 'images') {
          get().finishImages(await window.thumbGrove.moveImages(subject.ids, destination.path), 'Moved')
          return
        }
        const { folder } = subject
        await window.thumbGrove.moveFolder(folder.id, destination.path)
        const previousParent = folder.path.slice(0, folder.path.lastIndexOf('\\'))
        notify(`Moved “${folder.name}” to ${destination.name}`, 'default', {
          label: 'Undo',
          run: () => {
            useAppStore.setState({ toasts: [] })
            window.thumbGrove.moveFolder(folder.id, previousParent).catch((error: unknown) => notify(errorMessage(error), 'error'))
          }
        })
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },
    openMenu: (menu) => set({ menu }),

    toggleImage: (id, index) =>
      set((s) => ({
        selected: s.selected.includes(id) ? s.selected.filter((other) => other !== id) : [...s.selected, id],
        selectionAnchor: index
      })),

    selectRangeTo: async (index) => {
      const anchor = get().selectionAnchor ?? index
      const start = Math.min(anchor, index)
      const { items } = await window.thumbGrove.listImages({ ...query(start), limit: Math.abs(index - anchor) + 1 })
      set((s) => ({ selected: [...new Set([...s.selected, ...items.map((item) => item.id)])] }))
    },

    selectAllImages: async () => {
      const { total } = get()
      if (!total) return
      const { items } = await window.thumbGrove.listImages({ ...query(0), limit: total })
      set({ selected: items.map((item) => item.id) })
    },

    clearSelection: () => set({ selected: [], selectionAnchor: null }),

    finishImages: (outcome, verb) => {
      const { notify } = useAppStore.getState()
      const done = outcome.results.filter((result) => result.ok)
      const failed = outcome.results.filter((result) => !result.ok)
      if (done.length) {
        const token = outcome.undoToken
        const undo = token === null ? undefined : {
          label: 'Undo',
          run: () => {
            useAppStore.setState({ toasts: [] })
            window.thumbGrove.undoReview(token).catch((error: unknown) => notify(errorMessage(error), 'error'))
          }
        }
        notify(done.length === 1 ? `${verb} ${done[0]!.name}` : `${verb} ${done.length} images`, 'default', undo)
        set({ selected: [], selectionAnchor: null })
      }
      if (failed.length) notify(`${failed.length > 1 ? `${failed.length} images failed. ` : ''}${failed[0]!.error ?? ''}`, 'error')
    },

    queueImages: async (ids) => {
      reportQueued(await window.thumbGrove.enqueueForDiscord(ids))
    },

    queueFolder: async (folder) => {
      const result = await window.thumbGrove.enqueueFolderForDiscord(folder.id)
      reportQueued(result)
      if (!result.queued && !result.unknown && !result.alreadyPosted) useAppStore.getState().notify('This folder has no images to queue.')
    },

    toggleFavorite: async (folder) => {
      await window.thumbGrove.setFolderFavorite(folder.id, !folder.favorite)
    },

    retrack: async (path) => {
      try {
        await window.thumbGrove.retrackFolder(path)
        await refreshAll()
      } catch (error) {
        useAppStore.getState().notify(errorMessage(error), 'error')
      }
    },

    init: async (initial) => {
      settings = initial
      window.thumbGrove.onLibraryEvent((event) => {
        if (event.type === 'scan') {
          set({ scan: event.status })
        } else {
          // A burst of changes only needs one refresh.
          if (refreshTimer) clearTimeout(refreshTimer)
          refreshTimer = setTimeout(() => void refreshAll(), 150)
        }
      })
      await refreshAll()
      set({ ready: true })
    },

    setMode: async (mode) => {
      if (mode === get().mode) return
      set({ mode, search: '', includeSubfolders: false })
      const modeRoot = await loadModeRoot()
      set({ modeRoot, folderId: mode === 'folders' || mode === 'duplicates' ? null : (modeRoot?.id ?? null) })
      await reload(true)
    },

    open: async (folderId) => {
      set({ folderId, search: '' })
      await reload(true)
      if (folderId !== null) {
        const expanded = { ...get().expanded }
        for (const crumb of get().crumbs.slice(0, -1)) expanded[crumb.id] = true
        set({ expanded })
        await refreshTree()
      }
    },

    setSearch: (search) => {
      set({ search })
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => void reload(true), 160)
    },

    setSort: (sort) => {
      set({ sort })
      void reload(true)
    },

    setIncludeSubfolders: (includeSubfolders) => {
      set({ includeSubfolders })
      void reload(true)
    },

    ensureRange: (first, last) => {
      for (let page = Math.floor(Math.max(0, first) / PAGE_SIZE); page <= Math.floor(Math.max(0, last) / PAGE_SIZE); page++) {
        void fetchPage(page)
      }
    },

    toggleTree: async (folderId) => {
      const open = !get().expanded[folderId]
      set((s) => ({ expanded: { ...s.expanded, [folderId]: open } }))
      if (open) {
        const list = await window.thumbGrove.getChildren(folderId)
        set((s) => ({ tree: { ...s.tree, [treeKey(folderId)]: list } }))
      }
    },

    addRoot: async () => {
      try {
        const root = await window.thumbGrove.addRoot()
        if (root) await refreshAll()
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    addRootPath: async (path) => {
      try {
        await window.thumbGrove.addRootPath(path)
        await refreshAll()
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    removeRoot: async (id) => {
      await window.thumbGrove.removeRoot(id)
      const { crumbs, mode } = get()
      if (crumbs.some((c) => c.rootId === id)) {
        set({ folderId: null, mode })
      }
      await refreshAll()
    },

    rescan: () => window.thumbGrove.rescan(),

    openViewer: (index, origin) => set({ viewer: { index, origin } }),
    closeViewer: () => set({ viewer: null }),

    stepViewer: (delta) => {
      const { viewer, total } = get()
      if (!viewer) return
      const index = Math.min(total - 1, Math.max(0, viewer.index + delta))
      if (index !== viewer.index) set({ viewer: { index, origin: null } })
      get().ensureRange(index - 1, index + 1)
    },

    clearError: () => set({ error: null })
  }
})

export function imageAt(state: Pick<LibraryState, 'pages'>, index: number): ImageInfo | undefined {
  return state.pages[Math.floor(index / PAGE_SIZE)]?.[index % PAGE_SIZE]
}

/** Lets the Sets and Characters views pick up a destination folder change from Settings. */
export async function applySettings(next: Settings): Promise<void> {
  settings = next
  const { mode, setMode } = useLibraryStore.getState()
  if (mode !== 'folders') {
    useLibraryStore.setState({ mode: 'folders' })
    await setMode(mode)
  }
}
