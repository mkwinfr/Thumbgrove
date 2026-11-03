import type { ComponentType } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useAppStore } from './store'
import { Flights } from './components/Flights'
import { ModelDialog } from './components/ModelDialog'
import { Rail } from './components/Rail'
import { Toasts } from './components/Toasts'
import { CataloguesView } from './features/catalogues/CataloguesView'
import { CharactersView } from './features/characters/CharactersView'
import { DiscordView } from './features/discord/DiscordView'
import { FoldersView } from './features/folders/FoldersView'
import { AutoApprovedDialog } from './features/review/AutoApprovedDialog'
import { CharacterNameDialog } from './features/review/CharacterNameDialog'
import { ReviewView } from './features/review/ReviewView'
import { SettingsView } from './features/settings/SettingsView'
import type { ViewName } from './types'

const VIEWS: Record<ViewName, ComponentType> = {
  folders: FoldersView,
  review: ReviewView,
  characters: CharactersView,
  discord: DiscordView,
  catalogues: CataloguesView,
  settings: SettingsView
}

export function App() {
  const view = useAppStore((s) => s.view)
  const View = VIEWS[view]
  return (
    <div className="app">
      <div className="ambient ambient-violet" />
      <div className="ambient ambient-teal" />
      <div className="drag-region" />
      <Rail />
      <main className="main">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            className="view"
            initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <View />
          </motion.div>
        </AnimatePresence>
      </main>
      <Flights />
      <Toasts />
      <ModelDialog />
      <CharacterNameDialog />
      <AutoApprovedDialog />
    </div>
  )
}
