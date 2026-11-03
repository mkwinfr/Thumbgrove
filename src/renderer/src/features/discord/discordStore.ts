import { create } from 'zustand'
import type { DiscordLink, DiscordStatus, HistoryEntry, QueueEntry, ThreadKind, UploadStatus } from '../../../../shared/api'
import { errorMessage } from '../../errors'
import { useAppStore, type Toast } from '../../store'

export type DiscordTab = 'queue' | 'threads' | 'history'

export interface ConnectRequest {
  kind: ThreadKind
  name: string
  /** Images offered as the thread's first image. */
  imageIds: Array<{ id: number; mtimeMs: number }>
}

interface DiscordState {
  ready: boolean
  tab: DiscordTab
  status: DiscordStatus | null
  links: DiscordLink[]
  queue: QueueEntry[]
  history: HistoryEntry[]
  upload: UploadStatus | null
  /** Queued images picked for removing. */
  selected: number[]
  connect: ConnectRequest | null

  init(): Promise<void>
  reload(): Promise<void>
  refreshStatus(): Promise<void>
  setTab(tab: DiscordTab): void
  setConnect(request: ConnectRequest | null): void
  startUpload(ids: number[]): Promise<void>
  removeFromQueue(ids: number[]): Promise<void>
  toggleSelected(id: number): void
  selectMany(ids: number[]): void
  clearSelected(): void
  startCheck(): Promise<void>
  unlink(kind: ThreadKind, name: string): Promise<void>
  deletePost(id: number): Promise<void>
}

let reloadTimer: ReturnType<typeof setTimeout> | null = null
let uploadLimit: number | null = null

export const useDiscordStore = create<DiscordState>((set, get) => {
  const notify = (message: string, tone: 'default' | 'error' = 'default', action?: Toast['action']): void => useAppStore.getState().notify(message, tone, action)

  return {
    ready: false,
    tab: 'queue',
    status: null,
    links: [],
    queue: [],
    history: [],
    upload: null,
    selected: [],
    connect: null,

    init: async () => {
      window.thumbGrove.onLibraryEvent((event) => {
        if (event.type === 'settings') {
          // A new upload limit changes which queued images are flagged.
          if (event.settings.uploadLimitMb !== uploadLimit) {
            uploadLimit = event.settings.uploadLimitMb
            void get().refreshStatus()
            void get().reload()
          }
        } else if (event.type === 'discord') {
          if (reloadTimer) clearTimeout(reloadTimer)
          reloadTimer = setTimeout(() => void get().reload(), 80)
        } else if (event.type === 'upload') {
          const previous = get().upload?.phase
          set({ upload: event.status })
          if (previous !== event.status.phase && (event.status.phase === 'complete' || event.status.phase === 'cancelled')) {
            const { mode, posted, duplicates, failed, phase, warning } = event.status
            if (mode === 'check') {
              notify(duplicates ? `Removed ${duplicates} already on Discord` : 'Nothing in the queue matched what is on Discord')
            } else {
              const parts = [`${phase === 'cancelled' ? 'Stopped. Posted' : 'Posted'} ${posted}`]
              if (duplicates) parts.push(`${duplicates} already on Discord`)
              if (failed) parts.push(`${failed} failed`)
              notify(parts.join(', '), failed ? 'error' : 'default')
            }
            if (warning) notify(warning, 'error')
          }
        }
      })
      const [upload] = await Promise.all([window.thumbGrove.getDiscordUploadStatus(), get().reload()])
      set({ upload, ready: true })
      await get().refreshStatus()
    },

    reload: async () => {
      const [links, queue, history] = await Promise.all([
        window.thumbGrove.getDiscordLinks(),
        window.thumbGrove.getDiscordQueue(),
        window.thumbGrove.getDiscordHistory()
      ])
      set({ links, queue, history })
    },

    refreshStatus: async () => set({ status: await window.thumbGrove.getDiscordStatus() }),
    setTab: (tab) => set({ tab }),
    setConnect: (connect) => set({ connect }),

    startUpload: async (ids) => {
      try {
        await window.thumbGrove.startDiscordUpload(ids)
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },

    removeFromQueue: async (ids) => {
      const removed = await window.thumbGrove.removeFromDiscordQueue(ids)
      set((s) => ({ selected: s.selected.filter((id) => !ids.includes(id)) }))
      if (removed.length) {
        notify(removed.length === 1 ? 'Removed from the queue' : `Removed ${removed.length} from the queue`, 'default', {
          label: 'Undo',
          run: () => {
            useAppStore.setState({ toasts: [] })
            void window.thumbGrove.restoreToDiscordQueue(removed)
          }
        })
      }
    },

    toggleSelected: (id) => set((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((other) => other !== id) : [...s.selected, id] })),
    selectMany: (ids) => set((s) => ({ selected: [...new Set([...s.selected, ...ids])] })),
    clearSelected: () => set({ selected: [] }),

    startCheck: async () => {
      try {
        await window.thumbGrove.startDiscordCheck()
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },

    unlink: async (kind, name) => {
      await window.thumbGrove.unlinkDiscordThread(kind, name)
    },

    deletePost: async (id) => {
      try {
        await window.thumbGrove.deleteDiscordPost(id)
        notify('Deleted from Discord. The image on this computer was kept.')
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    }
  }
})
