import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted: index.css asks for these by name, and a webfont that never
// loads fails silently — the whole UI just renders in system-ui instead.
import '@fontsource-variable/inter'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import './index.css'
import { applyStoredTheme } from '@/store/theme'
import { ErrorBoundary, installGlobalErrorCapture } from '@/components/DebugErrorOverlay'
import App from './App.tsx'

applyStoredTheme()
installGlobalErrorCapture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
