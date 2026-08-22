import { create } from 'zustand'
import type { ActiveSigner } from '@formstr/signer'
import type { MailSettings } from '@/lib/nostr/settings'
import { saveSettings, loadSettingsDetailed } from '@/lib/nostr/settings'

interface SettingsState {
  settings: MailSettings
  loading: boolean
  /** True once a load has completed for the current account — distinguishes
   *  "settings not fetched yet" from "fetched, nothing saved". The onboarding
   *  gate needs this so it never flashes before settings are known. */
  loaded: boolean
  /** A settings event was seen on the relays this load, decryptable or not.
   *  Guards blind overwrites — see ensureMailIndexKey. */
  eventExists: boolean
  /** `created_at` of the newest settings event seen, if any. Lets us tell that
   *  the user's settings event exists (and when it last changed) even when we
   *  couldn't read it. */
  version?: number
  load: (pubkey: string, active: ActiveSigner) => Promise<void>
  save: (settings: MailSettings, pubkey: string, active: ActiveSigner) => Promise<void>
  update: (patch: Partial<MailSettings>) => void
}

export const useSettingsStore = create<SettingsState>()((set, _get) => ({
  settings: {},
  loading: false,
  loaded: false,
  eventExists: false,
  version: undefined,

  load: async (pubkey, active) => {
    // Reset `loaded` up front so the onboarding gate can't fire on a previous
    // account's settings while this fetch is in flight.
    set({ loading: true, loaded: false })
    try {
      const result = await loadSettingsDetailed(pubkey, active)
      // Always replace (not "only when found"): an account with no saved
      // settings must read as empty, otherwise the prior account's settings —
      // including its `onboardedAt` — bleed across a switch and suppress the
      // new account's onboarding.
      set({
        settings: result.settings ?? {},
        eventExists: result.eventExists,
        version: result.version,
      })
    } finally {
      set({ loading: false, loaded: true })
    }
  },

  save: async (settings, pubkey, active) => {
    set({ settings })
    await saveSettings(settings, pubkey, active)
    // The event now exists on the relays — record that so a later mint doesn't
    // treat settings as never-saved.
    set({ eventExists: true, version: Math.floor(Date.now() / 1000) })
  },

  update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
}))
