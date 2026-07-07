import { create } from 'zustand'
import type { MailSettings } from '@/lib/nostr/settings'
import { saveSettings, loadSettings } from '@/lib/nostr/settings'
import type { Signer } from '@/lib/nostr/signer'

interface SettingsState {
  settings: MailSettings
  loading: boolean
  load: (pubkey: string, signer: Signer, sk: Uint8Array | null) => Promise<void>
  save: (settings: MailSettings, pubkey: string, sk: Uint8Array) => Promise<void>
  update: (patch: Partial<MailSettings>) => void
}

export const useSettingsStore = create<SettingsState>()((set, _get) => ({
  settings: {},
  loading: false,

  load: async (pubkey, signer, sk) => {
    set({ loading: true })
    try {
      const loaded = await loadSettings(pubkey, signer, sk)
      if (loaded) set({ settings: loaded })
    } finally {
      set({ loading: false })
    }
  },

  save: async (settings, pubkey, sk) => {
    set({ settings })
    await saveSettings(settings, pubkey, sk)
  },

  update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
}))
