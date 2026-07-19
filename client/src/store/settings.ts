import { create } from 'zustand'
import type { ActiveSigner } from '@formstr/signer'
import type { MailSettings } from '@/lib/nostr/settings'
import { saveSettings, loadSettings } from '@/lib/nostr/settings'

interface SettingsState {
  settings: MailSettings
  loading: boolean
  load: (pubkey: string, active: ActiveSigner) => Promise<void>
  save: (settings: MailSettings, pubkey: string, active: ActiveSigner) => Promise<void>
  update: (patch: Partial<MailSettings>) => void
}

export const useSettingsStore = create<SettingsState>()((set, _get) => ({
  settings: {},
  loading: false,

  load: async (pubkey, active) => {
    set({ loading: true })
    try {
      const loaded = await loadSettings(pubkey, active)
      if (loaded) set({ settings: loaded })
    } finally {
      set({ loading: false })
    }
  },

  save: async (settings, pubkey, active) => {
    set({ settings })
    await saveSettings(settings, pubkey, active)
  },

  update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
}))
