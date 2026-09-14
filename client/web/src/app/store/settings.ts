import { create } from 'zustand'
import type { ActiveSigner } from '@formstr/signer'
import type { MailSettings } from '@/app/lib/nostr/settings'
import { saveSettings, loadSettingsDetailed } from '@/app/lib/nostr/settings'
import { isCurrentSession, sessionEpoch } from '@/app/store/sessionEpoch'

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
  /**
   * Publish a patch of settings. Only the keys present in `patch` are written
   * (merged into the live blob inside the serialized chain), so a slow writer
   * holding a stale snapshot (PGP discovery, an onboarding finish) cannot
   * clobber a field another writer changed in the meantime.
   */
  save: (patch: Partial<MailSettings>, pubkey: string, active: ActiveSigner) => Promise<void>
  update: (patch: Partial<MailSettings>) => void
  /** Wipe account-scoped state on logout / account switch, before the next
   *  account's load can resolve. Without this the previous account's settings
   *  (signature, PGP keys, mail index key) serve the new account. */
  reset: () => void
}

/**
 * Saves are serialized through one promise chain. `save()` publishes the whole
 * settings blob, so two concurrent writers (a user edit and a background
 * discovery save) would otherwise be last-writer-wins over each other's fields.
 * The queue runs each save with the LATEST state merged in, so a slow earlier
 * save cannot clobber a field written by a later one.
 */
let saveChain: Promise<void> = Promise.resolve()

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: {},
  loading: false,
  loaded: false,
  eventExists: false,
  version: undefined,

  load: async (pubkey, active) => {
    // Clear the previous account's blob and reset `loaded` up front: the
    // onboarding gate must not fire on stale settings, and a failed fetch must
    // not leave the old account's signature/PGP keys serving the new one.
    set({ loading: true, loaded: false, settings: {}, eventExists: false, version: undefined })
    const session = sessionEpoch()
    try {
      const result = await loadSettingsDetailed(pubkey, active)
      // A load that straddles a logout/switch must not install the old
      // account's settings into the new one.
      if (!isCurrentSession(session)) return
      set({
        settings: result.settings ?? {},
        eventExists: result.eventExists,
        version: result.version,
      })
    } finally {
      if (isCurrentSession(session)) set({ loading: false, loaded: true })
    }
  },

  save: async (patch, pubkey, active) => {
    // Capture the session so a save that straddles a logout/switch cannot
    // commit its result into the incoming account's store.
    const session = sessionEpoch()
    const run = saveChain.then(async () => {
      // Merge against the LIVE settings at publish time, not a caller snapshot.
      const merged = { ...get().settings, ...patch }
      await saveSettings(merged, pubkey, active)
      // Only now is the state durable on the relays. Committing after the
      // publish is what stops `ensureMailIndexKey` from handing out a key it
      // never persisted (audit B5).
      if (!isCurrentSession(session)) return
      set({
        settings: merged,
        eventExists: true,
        version: Math.floor(Date.now() / 1000),
      })
    })
    // Keep the chain alive after a failure so one bad save doesn't wedge every
    // later save; the caller still sees this save's rejection.
    saveChain = run.catch(() => {})
    return run
  },

  update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  reset: () => {
    // A new account must not have its saves serialized behind the previous
    // account's in-flight chain.
    saveChain = Promise.resolve()
    set({
      settings: {},
      loading: false,
      loaded: false,
      eventExists: false,
      version: undefined,
    })
  },
}))
