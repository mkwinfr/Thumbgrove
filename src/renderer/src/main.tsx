import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import '@fontsource-variable/outfit'
import './styles.css'
import { App } from './App'
import { useDiscordStore } from './features/discord/discordStore'
import { useLibraryStore } from './features/folders/libraryStore'
import { useAppStore } from './store'

async function start(): Promise<void> {
  const settings = await window.thumbGrove.getSettings()
  useAppStore.getState().hydrateSettings(settings)
  await useAppStore.getState().initReview()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </StrictMode>
  )
  await Promise.all([useLibraryStore.getState().init(settings), useDiscordStore.getState().init()])
}

void start()
