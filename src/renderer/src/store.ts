import { create } from 'zustand'
import { thumbUrl, type ApplyRequest, type LibraryEvent, type RecognitionStatus, type Settings, type SettingsChange } from '../../shared/api'
import { canonical, displayName, extensionOf, imageName, nameKey, namingBase, type CharacterName } from '../../shared/naming'
import type { PlacementRoots } from '../../shared/placement'
import { errorMessage } from './errors'
import type { Draft, ExitKind, ReviewItem, ViewName } from './types'

const UNDO_DEPTH = 20
const TOAST_MS = 5000
const MAX_FLIGHTS = 5
const DRAFT_SAVE_MS = 300
const RELOAD_MS = 120

export interface Toast {
  id: number
  message: string
  tone: 'default' | 'error'
  action?: { label: string; run(): void }
}

export type SettingsSection = 'folders' | 'review' | 'discord' | 'about'

export type ReviewFilter = 'all' | 'needs' | 'strong'

export interface Flight {
  id: number
  src: string
  delay: number
}

interface AppState {
  view: ViewName
  settings: Settings
  settingsOpen: boolean
  settingsSection: SettingsSection
  modelDialogOpen: boolean
  reviewFilter: ReviewFilter
  /** The last characters and set applied, ready to reuse. */
  lastChoice: { characters: string[]; setName: string | null } | null
  queueLimit: number
  roots: PlacementRoots
  names: CharacterName[]
  knownCharacters: string[]
  sets: string[]
  gridMode: boolean
  exitKind: ExitKind
  shake: number
  toasts: Toast[]
  flights: Flight[]
  editingCharacter: string | null

  queue: ReviewItem[]
  drafts: Record<number, Draft>
  focusId: number | null
  selection: number[]
  /** Lowercase filenames already taken. */
  usedNames: Set<string>
  discordQueued: number
  autoApproved: number
  autoApprovedOpen: boolean
  recognition: RecognitionStatus | null

  setView(view: ViewName): void
  setSettingsOpen(open: boolean): void
  setSettingsSection(section: SettingsSection): void
  openSettings(section: SettingsSection): void
  setModelDialogOpen(open: boolean): void
  setAutoApprovedOpen(open: boolean): void
  updateSettings(change: SettingsChange): Promise<void>
  setReviewFilter(filter: ReviewFilter): void
  hydrateSettings(settings: Settings): void
  setGridMode(on: boolean): void
  initReview(): Promise<void>
  reloadReview(): Promise<void>

  startScan(folderId: number, includeSubfolders: boolean, force?: boolean): Promise<void>

  focus(id: number): void
  step(delta: number): void
  toggleSelect(id: number): void
  selectRange(id: number): void
  selectAll(): void
  selectMany(ids: number[]): void
  selectStrong(): void
  clearSelection(): void
  useLastChoice(): void

  toggleCharacter(tag: string): void
  addCharacter(name: string): void
  chooseSet(name: string | null): void
  setCustomName(name: string | null): void
  setPlaceInCharacters(on: boolean): void
  setPlaceInSet(on: boolean): void
  setEditingCharacter(raw: string | null): void
  saveCharacterName(raw: string, name: string, series: string): Promise<void>

  apply(queueForDiscord?: boolean): Promise<void>
  skip(): Promise<void>
  remove(): Promise<void>
  clearQueue(): Promise<void>
  undo(): Promise<void>

  notify(message: string, tone?: Toast['tone'], action?: Toast['action']): void
  dismissToast(id: number): void
  finishFlight(id: number): void
}

function seedDraft(item: ReviewItem, settings: Settings): Draft {
  return {
    characters: item.candidates.filter((c) => !c.filenameOnly && c.score >= settings.preselectThreshold).map((c) => c.tag),
    setName: null,
    customName: null,
    placeInCharacters: settings.defaultPlaceInCharacters,
    placeInSet: settings.defaultPlaceInSet
  }
}

function isStrong(item: ReviewItem, settings: Settings): boolean {
  return item.candidates.some((c) => !c.filenameOnly && c.score >= settings.preselectThreshold)
}

/** The queue after the grid's filter. */
export function visibleQueue(state: Pick<AppState, 'queue' | 'drafts' | 'reviewFilter' | 'settings'>): ReviewItem[] {
  if (state.reviewFilter === 'strong') return state.queue.filter((item) => isStrong(item, state.settings))
  if (state.reviewFilter === 'needs') {
    return state.queue.filter((item) => {
      const draft = state.drafts[item.id]
      return !draft || (!draft.characters.length && !draft.setName)
    })
  }
  return state.queue
}

/** The images an action affects: the selection when there is one, otherwise the focused image. */
export function targetIds(state: Pick<AppState, 'selection' | 'focusId'>): number[] {
  if (state.selection.length) return state.selection
  return state.focusId !== null ? [state.focusId] : []
}

/** Generates each target's filename, numbering them in order so a batch never collides. */
export function previewNames(
  state: Pick<AppState, 'queue' | 'drafts' | 'names' | 'usedNames'>,
  ids: number[]
): Map<number, string> {
  const used = new Set(state.usedNames)
  const result = new Map<number, string>()
  for (const id of ids) {
    const item = state.queue.find((i) => i.id === id)
    const draft = state.drafts[id]
    if (!item || !draft) continue
    const base = namingBase(draft.characters, state.names, draft.setName ?? '')
    const name = draft.customName ?? (base ? imageName(base, extensionOf(item.name), used) : item.name)
    used.add(name.toLowerCase())
    result.set(id, name)
  }
  return result
}

let nextToastId = 1
let nextFlightId = 1
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let draftTimer: ReturnType<typeof setTimeout> | null = null
const unsavedDrafts = new Set<number>()
/** Images already gone from the screen while the app finishes acting on them. */
const leaving = new Set<number>()
/** Names being applied right now, so that quick successive applies don't pick the same one. */
const reservedNames = new Set<string>()
const undoTokens: number[] = []

export const useAppStore = create<AppState>((set, get) => {
  const pushToast = (message: string, options: { tone?: Toast['tone']; action?: Toast['action'] } = {}): void => {
    const id = nextToastId++
    set((s) => ({
      toasts: [...s.toasts.slice(-2), { id, message, tone: options.tone ?? 'default', ...(options.action ? { action: options.action } : {}) }]
    }))
    setTimeout(() => get().dismissToast(id), TOAST_MS)
  }

  const flushDrafts = async (): Promise<void> => {
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = null
    if (!unsavedDrafts.size) return
    const { drafts } = get()
    const list = [...unsavedDrafts].flatMap((id) => (drafts[id] ? [{ id, draft: drafts[id] }] : []))
    unsavedDrafts.clear()
    await window.thumbGrove.saveDrafts(list)
  }

  const updateTargets = (change: (draft: Draft) => Draft): void => {
    set((s) => {
      const drafts = { ...s.drafts }
      for (const id of targetIds(s)) {
        const draft = drafts[id]
        if (draft) {
          drafts[id] = change(draft)
          unsavedDrafts.add(id)
        }
      }
      return { drafts }
    })
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => void flushDrafts(), DRAFT_SAVE_MS)
  }

  /** Takes images off the screen at once and focuses the image that takes their place. */
  const leaveQueue = (ids: number[], exitKind: ExitKind): void => {
    for (const id of ids) leaving.add(id)
    set((s) => {
      const gone = new Set(ids)
      const firstIndex = s.queue.findIndex((i) => gone.has(i.id))
      const queue = s.queue.filter((i) => !gone.has(i.id))
      const focus = queue[Math.min(firstIndex, queue.length - 1)]
      return { queue, exitKind, selection: [], focusId: focus?.id ?? null }
    })
  }

  const finishLeaving = async (ids: number[]): Promise<void> => {
    for (const id of ids) leaving.delete(id)
    await get().reloadReview()
  }

  const rememberUndo = (token: number): Toast['action'] => {
    undoTokens.push(token)
    if (undoTokens.length > UNDO_DEPTH) undoTokens.shift()
    return { label: 'Undo', run: () => void runUndo(token) }
  }

  const runUndo = async (token: number): Promise<void> => {
    const index = undoTokens.indexOf(token)
    if (index < 0) return
    undoTokens.splice(index, 1)
    set({ toasts: [], exitKind: 'previous' })
    try {
      await window.thumbGrove.undoReview(token)
    } catch (error) {
      pushToast(errorMessage(error), { tone: 'error' })
    }
    await get().reloadReview()
  }

  const onRecognition = (status: RecognitionStatus): void => {
    const previous = get().recognition?.phase
    set({ recognition: status })
    if (previous === status.phase) return
    if (status.phase === 'complete' && previous === 'downloading') {
      set({ modelDialogOpen: false })
      pushToast('The recognition model is ready. Choose Scan folder to begin.')
    } else if (status.phase === 'complete') {
      const auto = status.autoApproved ? `, ${status.autoApproved} auto-approved` : ''
      pushToast(`Scanned ${status.done} ${status.done === 1 ? 'image' : 'images'}${auto}`, status.autoApproved ? { action: { label: 'See them', run: () => set({ view: 'review', settingsOpen: false, autoApprovedOpen: true }) } } : {})
    } else if (status.phase === 'error' && status.error) {
      pushToast(status.error, { tone: 'error' })
    }
  }

  const onEvent = (event: LibraryEvent): void => {
    if (event.type === 'recognition') {
      onRecognition(event.status)
    } else if (event.type === 'settings') {
      get().hydrateSettings(event.settings)
    } else if (event.type === 'reviews') {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => void get().reloadReview(), RELOAD_MS)
    }
  }

  return {
    view: 'folders',
    settings: {
      queueLimit: 200,
      autoApprove: true,
      autoApproveThreshold: 0.9,
      preselectThreshold: 0.75,
      charactersRoot: '',
      setsRoot: '',
      autoScanEnabled: false,
      autoScanFolder: '',
      autoScanSubfolders: false,
      defaultPlaceInCharacters: true,
      defaultPlaceInSet: true,
      carrySet: false,
      tileSize: 172,
      uploadLimitMb: 0,
      checkBeforeUpload: true,
      learnCorrections: true
    },
    settingsOpen: false,
    settingsSection: 'folders',
    modelDialogOpen: false,
    reviewFilter: 'all',
    lastChoice: null,
    queueLimit: 200,
    roots: { characters: '', sets: '' },
    names: [],
    knownCharacters: [],
    sets: [],
    gridMode: false,
    exitKind: 'next',
    shake: 0,
    toasts: [],
    flights: [],
    editingCharacter: null,

    queue: [],
    drafts: {},
    focusId: null,
    selection: [],
    usedNames: new Set(),
    discordQueued: 0,
    autoApproved: 0,
    autoApprovedOpen: false,
    recognition: null,

    setView: (view) => set({ view }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setSettingsSection: (settingsSection) => set({ settingsSection }),
    openSettings: (settingsSection) => set({ settingsOpen: true, settingsSection }),
    setModelDialogOpen: (modelDialogOpen) => set({ modelDialogOpen }),
    setAutoApprovedOpen: (autoApprovedOpen) => set({ autoApprovedOpen }),
    updateSettings: async (change) => {
      // Shown at once, so that sliders follow the pointer. A refused value is put back below.
      const previous = get().settings
      set({ settings: { ...previous, ...change } })
      try {
        get().hydrateSettings(await window.thumbGrove.updateSettings(change))
      } catch (error) {
        set({ settings: previous })
        pushToast(errorMessage(error), { tone: 'error' })
      }
    },
    setReviewFilter: (reviewFilter) => set({ reviewFilter, selection: [] }),
    hydrateSettings: (settings) =>
      set({
        settings,
        queueLimit: settings.queueLimit,
        roots: { characters: settings.charactersRoot, sets: settings.setsRoot }
      }),
    setGridMode: (gridMode) => set({ gridMode }),

    initReview: async () => {
      window.thumbGrove.onLibraryEvent(onEvent)
      const [status] = await Promise.all([window.thumbGrove.getRecognitionStatus(), get().reloadReview()])
      set({ recognition: status })
    },

    reloadReview: async () => {
      await flushDrafts()
      const state = await window.thumbGrove.getReviewState()
      set((s) => {
        const queue = state.items.filter((item) => !leaving.has(item.id))
        const drafts: Record<number, Draft> = {}
        for (const item of queue) drafts[item.id] = s.drafts[item.id] ?? item.draft ?? seedDraft(item, s.settings)
        const ids = new Set(queue.map((item) => item.id))
        const selection = s.selection.filter((id) => ids.has(id))
        const previousIndex = s.queue.findIndex((item) => item.id === s.focusId)
        const focusId =
          s.focusId !== null && ids.has(s.focusId)
            ? s.focusId
            : (queue[Math.min(Math.max(previousIndex, 0), queue.length - 1)]?.id ?? null)
        // Sets chosen for images not yet applied don't have a folder yet, so they're kept from the drafts.
        const draftSets = Object.values(drafts).flatMap((draft) => draft.setName ?? [])
        const sets = [...new Map([...state.sets, ...draftSets].map((name) => [name.toLowerCase(), name])).values()].sort((a, b) => a.localeCompare(b))
        return {
          queue,
          drafts,
          selection: selection.length > 1 ? selection : [],
          focusId,
          names: state.names,
          sets,
          knownCharacters: state.knownCharacters,
          usedNames: new Set([...state.usedNames, ...reservedNames]),
          discordQueued: state.discordQueued,
          autoApproved: state.autoApproved
        }
      })
    },

    startScan: async (folderId, includeSubfolders, force = false) => {
      try {
        const count = await window.thumbGrove.startRecognition({ folderId, includeSubfolders, force })
        if (count) return
        if (get().queue.length >= get().queueLimit) {
          pushToast('The review queue is full. Review or clear it first.', { tone: 'error' })
        } else {
          pushToast('Everything here has been scanned.', {
            action: { label: 'Scan again', run: () => void get().startScan(folderId, includeSubfolders, true) }
          })
        }
      } catch (error) {
        const message = errorMessage(error)
        if (message === 'MODEL_MISSING') set({ modelDialogOpen: true })
        else pushToast(message, { tone: 'error' })
      }
    },

    focus: (id) => {
      set((s) => {
        const from = s.queue.findIndex((i) => i.id === s.focusId)
        const to = s.queue.findIndex((i) => i.id === id)
        return { focusId: id, selection: [], exitKind: to < from ? 'previous' : 'next' }
      })
    },

    step: (delta) => {
      const { queue, focusId } = get()
      const index = queue.findIndex((i) => i.id === focusId)
      const next = queue[index + delta]
      if (next) set({ focusId: next.id, selection: [], exitKind: delta < 0 ? 'previous' : 'next' })
    },

    toggleSelect: (id) => {
      set((s) => {
        const current = s.selection.length ? s.selection : s.focusId !== null ? [s.focusId] : []
        const selection = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
        const focusId = selection.includes(id) ? id : (selection[selection.length - 1] ?? s.focusId)
        return { selection: selection.length > 1 ? selection : [], focusId }
      })
    },

    selectRange: (id) => {
      set((s) => {
        const from = s.queue.findIndex((i) => i.id === s.focusId)
        const to = s.queue.findIndex((i) => i.id === id)
        if (from < 0 || to < 0 || from === to) return {}
        const [start, end] = from < to ? [from, to] : [to, from]
        return { selection: s.queue.slice(start, end + 1).map((i) => i.id) }
      })
    },

    selectAll: () =>
      set((s) => {
        const visible = visibleQueue(s)
        return { selection: visible.length > 1 ? visible.map((i) => i.id) : [] }
      }),
    selectMany: (ids) =>
      set((s) => {
        const selection = [...new Set([...s.selection, ...ids])]
        return { selection: selection.length > 1 ? selection : [], focusId: ids[0] ?? s.focusId }
      }),
    selectStrong: () =>
      set((s) => {
        const strong = visibleQueue(s).filter((item) => isStrong(item, s.settings))
        return { selection: strong.length > 1 ? strong.map((i) => i.id) : [], focusId: strong[0]?.id ?? s.focusId }
      }),
    useLastChoice: () => {
      const last = get().lastChoice
      if (!last) return
      updateTargets((draft) => ({ ...draft, characters: last.characters, setName: last.setName, customName: null }))
    },
    clearSelection: () => set({ selection: [] }),

    toggleCharacter: (tag) => {
      const state = get()
      const key = nameKey(tag)
      const has = (draft: Draft | undefined): boolean => Boolean(draft?.characters.some((c) => nameKey(c) === key))
      // In a batch, a partly applied character is added to the rest before it can be removed.
      const everyTargetHasIt = targetIds(state).every((id) => has(state.drafts[id]))
      updateTargets((draft) => ({
        ...draft,
        customName: null,
        characters: everyTargetHasIt
          ? draft.characters.filter((c) => nameKey(c) !== key)
          : has(draft)
            ? draft.characters
            : [...draft.characters, tag]
      }))
    },

    addCharacter: (name) => {
      const clean = name.trim()
      if (!clean) return
      const state = get()
      const known = state.knownCharacters.find(
        (raw) => nameKey(raw) === nameKey(clean) || nameKey(displayName(raw, state.names)) === nameKey(clean)
      )
      const value = known ?? canonical(clean)
      if (!known) set((s) => ({ knownCharacters: [...s.knownCharacters, value] }))
      updateTargets((draft) =>
        draft.characters.some((c) => nameKey(c) === nameKey(value))
          ? draft
          : { ...draft, customName: null, characters: [...draft.characters, value] }
      )
    },

    chooseSet: (name) => {
      const clean = name?.trim() || null
      if (clean && !get().sets.some((s) => s.toLowerCase() === clean.toLowerCase())) {
        set((s) => ({ sets: [...s.sets, clean].sort((a, b) => a.localeCompare(b)) }))
      }
      const matched = clean ? (get().sets.find((s) => s.toLowerCase() === clean.toLowerCase()) ?? clean) : null
      updateTargets((draft) => ({ ...draft, setName: matched, customName: null, placeInSet: get().settings.defaultPlaceInSet }))
    },

    setCustomName: (customName) => updateTargets((draft) => ({ ...draft, customName })),
    setPlaceInCharacters: (placeInCharacters) => updateTargets((draft) => ({ ...draft, placeInCharacters })),
    setPlaceInSet: (placeInSet) => updateTargets((draft) => ({ ...draft, placeInSet })),
    setEditingCharacter: (editingCharacter) => set({ editingCharacter }),

    saveCharacterName: async (raw, name, series) => {
      await window.thumbGrove.updateCharacter(raw, canonical(name), series)
      set({ editingCharacter: null })
      await get().reloadReview()
    },

    apply: async (queueForDiscord = false) => {
      const state = get()
      const ids = targetIds(state)
      if (!ids.length) return
      const unfinished = ids.filter((id) => {
        const draft = state.drafts[id]
        return !draft || (!draft.characters.length && !draft.setName)
      })
      if (unfinished.length) {
        const message =
          ids.length === 1
            ? 'Choose a character or a set first.'
            : `${unfinished.length} of ${ids.length} images have no character or set.`
        set((s) => ({ shake: s.shake + 1 }))
        pushToast(message, { tone: 'error' })
        return
      }
      const names = previewNames(state, ids)
      const requests: ApplyRequest[] = ids.flatMap((id) => {
        const draft = state.drafts[id]
        const name = names.get(id)
        if (!draft || !name) return []
        return [{
          id,
          name,
          characters: draft.characters,
          setName: draft.setName,
          placeInCharacters: draft.placeInCharacters,
          placeInSet: draft.placeInSet,
          queueForDiscord
        }]
      })
      const flights: Flight[] = requests.slice(0, MAX_FLIGHTS).map((request, index) => {
        const item = state.queue.find((i) => i.id === request.id)!
        return { id: nextFlightId++, src: thumbUrl(item.id, item.mtimeMs), delay: index * 0.06 }
      })
      for (const name of names.values()) reservedNames.add(name.toLowerCase())
      set((s) => ({
        usedNames: new Set([...s.usedNames, ...reservedNames]),
        flights: [...s.flights, ...flights],
        discordQueued: s.discordQueued + (queueForDiscord ? requests.length : 0)
      }))
      const applied = state.drafts[ids[0]!]!
      leaveQueue(ids, 'apply')
      set({ lastChoice: { characters: applied.characters, setName: applied.setName } })
      // Working through a set: the next image starts with the same one.
      const next = get().focusId
      if (state.settings.carrySet && applied.setName && next !== null && !get().drafts[next]?.setName) {
        updateTargets((draft) => ({ ...draft, setName: applied.setName, customName: null, placeInSet: state.settings.defaultPlaceInSet }))
      }
      await flushDrafts()
      try {
        const { results, undoToken } = await window.thumbGrove.applyReviews(requests)
        const applied = results.filter((r) => r.ok)
        const failed = results.filter((r) => !r.ok)
        const action = undoToken !== null ? rememberUndo(undoToken) : undefined
        if (applied.length) {
          pushToast(applied.length === 1 ? `Applied ${applied[0]!.name}` : `Applied ${applied.length} images`, action ? { action } : {})
        }
        if (failed.length) {
          const prefix = failed.length > 1 ? `${failed.length} images couldn't be applied. ` : ''
          pushToast(`${prefix}${failed[0]!.error ?? ''}`, { tone: 'error' })
        }
      } catch (error) {
        pushToast(errorMessage(error), { tone: 'error' })
      } finally {
        for (const name of names.values()) reservedNames.delete(name.toLowerCase())
      }
      await finishLeaving(ids)
    },

    skip: async () => {
      const ids = targetIds(get())
      if (!ids.length) return
      leaveQueue(ids, 'skip')
      const token = await window.thumbGrove.skipReviews(ids)
      pushToast(ids.length === 1 ? 'Skipped' : `Skipped ${ids.length} images`, { action: rememberUndo(token) })
      await finishLeaving(ids)
    },

    remove: async () => {
      const ids = targetIds(get())
      if (!ids.length) return
      leaveQueue(ids, 'delete')
      try {
        const count = await window.thumbGrove.deleteReviews(ids)
        pushToast(count === 1 ? 'Sent to the Recycle Bin' : `Sent ${count} images to the Recycle Bin`)
      } catch (error) {
        pushToast(errorMessage(error), { tone: 'error' })
      }
      await finishLeaving(ids)
    },

    clearQueue: async () => {
      const ids = get().queue.map((item) => item.id)
      if (!ids.length) return
      leaveQueue(ids, 'skip')
      const token = await window.thumbGrove.clearReviews()
      pushToast(`Cleared ${ids.length} suggestions. Your files were not changed.`, { action: rememberUndo(token) })
      await finishLeaving(ids)
    },

    undo: async () => {
      const token = undoTokens[undoTokens.length - 1]
      if (token !== undefined) await runUndo(token)
    },

    notify: (message, tone = 'default', action) => pushToast(message, { tone, ...(action ? { action } : {}) }),
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    finishFlight: (id) => set((s) => ({ flights: s.flights.filter((f) => f.id !== id) }))
  }
})
