import { create } from 'zustand'

/**
 * Device-local developer preferences. Kept out of the synced MailSettings on
 * purpose: these are debugging aids for the person at this machine, not account
 * state to replicate across devices. Persisted in localStorage like the theme.
 */
const STORAGE_KEY = 'mailstr.debugPanel'

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    // Private browsing and blocked storage both throw here; default to off.
    return false
  }
}

interface DevState {
  /** Show the raw-rumor debug disclosure under each open message. */
  debugPanel: boolean
  setDebugPanel: (on: boolean) => void
}

export const useDevStore = create<DevState>()((set) => ({
  debugPanel: readStored(),
  setDebugPanel: (on) => {
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
    } catch {
      // Storage refused it — the choice still applies for this session.
    }
    set({ debugPanel: on })
  },
}))
