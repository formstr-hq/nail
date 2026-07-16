import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { getLocalRelay } from '@/lib/nostr/localRelay'

// Spawn the local relay worker up front so IndexedDB hydration overlaps app
// startup instead of blocking the first observe.
getLocalRelay()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
