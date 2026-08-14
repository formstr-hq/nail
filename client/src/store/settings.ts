import { create } from 'zustand'
import type { ActiveSigner } from '@formstr/signer'
import type { MailSettings } from '@/lib/nostr/settings'
import { saveSettings, loadSettings } from '@/lib/nostr/settings'

interface SettingsState {
  settings: MailSettings
  loading: boolean
  /** True once a load has completed for the current account — distinguishes
   *  "settings not fetched yet" from "fetched, nothing saved". The onboarding
   *  gate needs this so it never flashes before settings are known. */
  loaded: boolean
  load: (pubkey: string, active: ActiveSigner) => Promise<void>
  save: (settings: MailSettings, pubkey: string, active: ActiveSigner) => Promise<void>
  update: (patch: Partial<MailSettings>) => void
}

export const useSettingsStore = create<SettingsState>()((set, _get) => ({
  settings: {},
  loading: false,
  loaded: false,

  load: async (pubkey, active) => {
    // Reset `loaded` up front so the onboarding gate can't fire on a previous
    // account's settings while this fetch is in flight.
    set({ loading: true, loaded: false })
    try {
      const loaded = await loadSettings(pubkey, active)
      // Always replace (not "only when found"): an account with no saved
      // settings must read as empty, otherwise the prior account's settings —
      // including its `onboardedAt` — bleed across a switch and suppress the
      // new account's onboarding.
      set({ settings: loaded ?? {} })
    } finally {
      set({ loading: false, loaded: true })
    }
  },

  save: async (settings, pubkey, active) => {
    set({ settings })
    await saveSettings(settings, pubkey, active)
  },

  update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
}))
