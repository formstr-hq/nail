import { create } from 'zustand'
import type { ActiveSigner } from '@formstr/signer'
import type { MailSettings } from '@/lib/nostr/settings'
import { saveSettings, subscribeSettings } from '@/lib/nostr/settings'

interface SettingsState {
  settings: MailSettings
  loading: boolean
  start: (pubkey: string, active: ActiveSigner) => void
  stop: () => void
  save: (settings: MailSettings, pubkey: string, active: ActiveSigner) => Promise<void>
  update: (patch: Partial<MailSettings>) => void
}

let unsubscribe: (() => void) | null = null

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: {},
  loading: false,

  start: (pubkey, active) => {
    get().stop()
    set({ settings: {}, loading: true })
    unsubscribe = subscribeSettings(
      pubkey,
      active,
      (settings) => set({ settings }),
      () => set({ loading: false }),
    )
  },

  stop: () => {
    unsubscribe?.()
    unsubscribe = null
    set({ loading: false })
  },

  save: async (settings, pubkey, active) => {
    set({ settings })
    await saveSettings(settings, pubkey, active)
  },

  update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
}))
