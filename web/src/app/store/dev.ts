import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * Device-local developer preferences. Kept out of the synced MailSettings on
 * purpose: these are debugging aids for the person at this machine, not account
 * state to replicate across devices. Persisted in localStorage like the theme.
 */
interface DevState {
  /** Show the raw-rumor debug disclosure under each open message. */
  debugPanel: boolean
  setDebugPanel: (on: boolean) => void
}

export const useDevStore = create<DevState>()(
  persist(
    (set) => ({
      debugPanel: false,
      setDebugPanel: (on) => set({ debugPanel: on }),
    }),
    {
      name: 'mailstr.debugPanel',
      storage: createJSONStorage(() => localStorage),
      // Migrate the legacy bare "on"/"off" string into the JSON envelope.
      version: 1,
      migrate: (persisted) => {
        if (typeof persisted === 'object' && persisted !== null && 'state' in persisted) {
          return persisted as { state: unknown; version: number }
        }
        return { state: { debugPanel: persisted === 'on' }, version: 1 }
      },
    },
  ),
)