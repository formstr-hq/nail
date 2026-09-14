import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import type { Email, EmailFolder, MailFlags } from '@/app/types/mail'

/**
 * Per-mail state (read / archived / trashed), keyed by gift-wrap id.
 *
 * This is the local, always-fast mirror of the kind-34578 metadata events that
 * carry mail state across devices (see lib/nostr/mailMeta.ts and the useMailMeta
 * hook that hydrates this from the relay). Every action updates this map first,
 * so the UI reacts instantly, then publishes in the background.
 *
 * It is cached to this device too: the store is otherwise in-memory (every fetch
 * rebuilds emails from the wraps with `read: false`), so without the cache the
 * inbox forgets what you've opened until the relay round-trips on each reload.
 * The relay copy remains the source of truth — `updatedAt` (the event's
 * `created_at`) decides which of two versions wins, so a stale replay never
 * clobbers a newer local or cross-device change.
 *
 * Persistence goes through zustand/persist with the SAME keys and value shapes
 * the hand-rolled helpers used, so existing devices upgrade in place:
 *  - `mailstr.mailstate.v1`  → mailState (Record<string, MailFlags>)
 *  - `mailstr.wrapkeys.v1`   → wrapKeys (Record<string, string>)
 *  - `mailstr.deleted.v1`    → deletedIds (string[])
 *  - `mailstr.read` (legacy) → folded into mailState on migrate, never deleted
 */
const STATE_KEY = 'mailstr.mailstate.v1'
// The pre-sync build kept only a set of opened gift-wrap ids here. Fold it into
// the new map on first load so nobody's read state resets on upgrade.
const LEGACY_READ_KEY = 'mailstr.read'
// Device-local deletion state. `wrapKeys` holds the wrap authors' ephemeral
// signing keys (the WRAP_KEY_TAG rumor tag, captured at unwrap) — the only
// credential that lets a NIP-09 kind-5 actually purge a wrap from relays, and
// a deletion-only capability: it cannot decrypt anything. `deletedIds` is the
// local tombstone set; a relay (or our own local cache, whose deletion ledger
// is in-memory) may keep serving a wrap after we deleted it, and this is what
// keeps "delete forever" from resurrecting on the next replay.
const WRAP_KEYS_KEY = 'mailstr.wrapkeys.v1'
const DELETED_KEY = 'mailstr.deleted.v1'

// --- legacy loaders (pre-persist format, used only by the migrate path) ---

function loadJsonObject<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, T> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, T>)) {
      if (typeof id === 'string' && value) out[id] = value
    }
    return out
  } catch {
    // Blocked/absent storage or malformed JSON — start empty. State just won't
    // persist this session, a far smaller failure than a crash.
    return {}
  }
}

function loadIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Fold the legacy `mailstr.read` set into mail state. Called from the persist
 * migrate step on first hydration so nobody's read state resets on upgrade.
 * The legacy key is NOT deleted: deleting it would break upgrades on devices
 * that still run the old build alongside (see AGENTS rule 8).
 */
function foldLegacyReadState(state: Record<string, MailFlags>): Record<string, MailFlags> {
  try {
    const raw = localStorage.getItem(LEGACY_READ_KEY)
    const ids: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(ids)) return state
    const merged = { ...state }
    for (const id of ids) {
      if (typeof id === 'string' && !merged[id]) merged[id] = { read: true, updatedAt: 0 }
    }
    return merged
  } catch {
    // Ignore a malformed legacy value.
    return state
  }
}

/**
 * The persist middleware's migrate step. The three persisted slices used to be
 * written by hand-rolled helpers as BARE values (a JSON map / array per key,
 * no persist envelope), so a pre-persist device's storage holds exactly the
 * shapes below. migrate receives whatever getItem produced — reconstruct each
 * slice, folding the legacy read set in.
 */
/**
 * The persist middleware's migrate step (version-mismatch path). Reconstructs
 * each slice; deletedIds arrive as the bare legacy array shape.
 */
function migratePersisted(raw: unknown): {
  mailState: Record<string, MailFlags>
  wrapKeys: Record<string, string>
  deletedIds: string[]
} {
  const slices = (raw ?? {}) as {
    mailState?: Record<string, MailFlags>
    wrapKeys?: Record<string, string>
    deletedIds?: unknown
  }
  const deletedIds = new Set(loadIdSet(DELETED_KEY))
  // A bare-array shape (pre-persist) is also accepted, in case a future
  // rollback wrote one.
  if (Array.isArray(slices.deletedIds)) {
    for (const id of slices.deletedIds) {
      if (typeof id === 'string') deletedIds.add(id)
    }
  }
  return {
    mailState: slices.mailState ?? {},
    wrapKeys: slices.wrapKeys ?? loadJsonObject<string>(WRAP_KEYS_KEY),
    deletedIds: Array.from(deletedIds),
  }
}

/**
 * PersistStorage that splits the store's persisted state across the SAME three
 * localStorage keys (and bare JSON shapes) the hand-rolled helpers used. Each
 * slice is written independently — a partial failure (quota, blocked storage)
 * degrades exactly like the old helpers did, key by key.
 */
const mailStorage: PersistStorage<{
  mailState: Record<string, MailFlags>
  wrapKeys: Record<string, string>
  deletedIds: string[]
}> = {
  getItem: () => {
    try {
      const mailState = loadJsonObject<MailFlags>(STATE_KEY)
      const wrapKeys = loadJsonObject<string>(WRAP_KEYS_KEY)
      const deletedIds = Array.from(loadIdSet(DELETED_KEY))
      // A completely empty read means "nothing persisted yet" — return null so
      // the persist middleware skips hydration/migrate entirely.
      const hasAnything =
        Object.keys(mailState).length > 0 ||
        Object.keys(wrapKeys).length > 0 ||
        deletedIds.length > 0
      if (!hasAnything) return null
      return { state: { mailState, wrapKeys, deletedIds } }
    } catch {
      return null
    }
  },
  setItem: (_key, envelope) => {
    const value = envelope.state
    try {
      if (value.mailState) localStorage.setItem(STATE_KEY, JSON.stringify(value.mailState))
    } catch {
      // Storage refused it — still applies in memory for this session.
    }
    try {
      localStorage.setItem(WRAP_KEYS_KEY, JSON.stringify(value.wrapKeys))
    } catch {
      // Storage refused it — still applies in memory for this session.
    }
    try {
      localStorage.setItem(DELETED_KEY, JSON.stringify(value.deletedIds))
    } catch {
      // Storage refused it — still applies in memory for this session.
    }
  },
  removeItem: () => {
    try {
      localStorage.removeItem(STATE_KEY)
      localStorage.removeItem(WRAP_KEYS_KEY)
      localStorage.removeItem(DELETED_KEY)
    } catch {
      // Storage unavailable — nothing to clear.
    }
  },
}

/** True when the mail is filed away (archived or trashed), so it leaves Inbox. */
export function isFiled(flags: MailFlags | undefined): boolean {
  return !!(flags?.archived || flags?.trashed)
}

interface MailState {
  emails: Record<string, Email>   // keyed by event ID
  seenIds: Set<string>
  /** kind-34578 metadata event ids already decoded this session, so a relay
   *  replay never pays a second signer round-trip (mirrors `seenIds`). */
  seenMetaIds: Set<string>
  mailState: Record<string, MailFlags> // read/archived/trashed/deleted by gift-wrap id
  /** Wrap-author ephemeral keys captured at unwrap; powers NIP-09 delete. */
  wrapKeys: Record<string, string>
  /** Gift-wrap ids permanently deleted on this device; never shown again. */
  deletedIds: Set<string>
  selectedId: string | null
  folder: EmailFolder
  query: string
  /**
   * Set when a cross-device delete removed the mail the user had open, so the
   * UI can say why the pane emptied instead of it vanishing silently (D1).
   */
  selectionClearedReason: 'deleted' | null
  /**
   * The last background mail-state publish that failed, so the UI can say
   * cross-device sync is degraded instead of losing the failure to the console
   * (audit B3). Cleared on the next successful publish or dismissal.
   */
  syncError: string | null
  // Which of the account's own addresses to show mail for, lowercased, or
  // `null` for "all mail". Every message still arrives at the one Nostr key;
  // this filters the view by which alias it was addressed from/to.
  inboxFilter: string | null
  addEmail: (email: Email) => void
  /** Remember a kind-34578 event id as decoded, so replays skip the signer. */
  markMetaSeen: (id: string) => void
  /** Merge a delta into a mail's flags and return the merged set for publishing. */
  setFlag: (id: string, patch: Partial<Omit<MailFlags, 'updatedAt'>>) => MailFlags
  /** Apply state learned from the relay, newest-wins by `updatedAt`. */
  hydrateFlags: (entries: { ref: string; flags: MailFlags }[]) => void
  /** Remember the wrap author's key so a later delete can be authored correctly. */
  saveWrapKey: (id: string, wrapKey: string) => void
  /**
   * Locally finalize a permanent delete: tombstone the wrap, purge the mail,
   * its wrap key, and set the deleted flag. Returns the merged flags for the
   * caller to publish as the mail's meta event.
   */
  markDeleted: (id: string) => MailFlags
  setFolder: (folder: EmailFolder) => void
  setSelected: (id: string | null) => void
  setQuery: (query: string) => void
  setInboxFilter: (address: string | null, keepSelection?: boolean) => void
  clearSelectionClearedReason: () => void
  setSyncError: (message: string | null) => void
  clear: () => void
}

export const useMailStore = create<MailState>()(
  persist(
    (set, get) => ({
      emails: {},
      seenIds: new Set(),
      seenMetaIds: new Set(),
      mailState: {},
      wrapKeys: {},
      deletedIds: new Set(),
      selectedId: null,
      folder: 'inbox' as EmailFolder,
      query: '',
      inboxFilter: null,
      selectionClearedReason: null,
      syncError: null,

      addEmail: (email) => {
        if (get().seenIds.has(email.id)) return
        // A deleted mail must never re-enter the view, however it arrives — a
        // relay replaying a wrap whose kind-5 it ignored, or our own cache after
        // reload (the local relay's deletion ledger is in-memory). Both the device
        // tombstone and the synced deleted flag are checked.
        if (get().deletedIds.has(email.id) || get().mailState[email.id]?.deleted) return
        // Re-apply known state: a freshly fetched wrap arrives read:false, but we
        // may have opened (or filed) it before, here or on another device.
        const read = email.read || !!get().mailState[email.id]?.read
        set((s) => ({
          emails: { ...s.emails, [email.id]: { ...email, read } },
          seenIds: new Set([...s.seenIds, email.id]),
        }))
      },

      markMetaSeen: (id) => {
        if (get().seenMetaIds.has(id)) return
        set((s) => ({ seenMetaIds: new Set([...s.seenMetaIds, id]) }))
      },

      setFlag: (id, patch) => {
        const prev = get().mailState[id]
        const merged: MailFlags = { ...prev, ...patch, updatedAt: Math.floor(Date.now() / 1000) }
        set((s) => {
          const mailState = { ...s.mailState, [id]: merged }
          const email = s.emails[id]
          const emails =
            email && merged.read !== undefined && email.read !== merged.read
              ? { ...s.emails, [id]: { ...email, read: !!merged.read } }
              : s.emails
          return { mailState, emails }
        })
        return merged
      },

      hydrateFlags: (entries) =>
        set((s) => {
          const mailState = { ...s.mailState }
          const emails = { ...s.emails }
          let deletedIds = s.deletedIds
          let wrapKeys = s.wrapKeys
          let selectedId = s.selectedId
          let selectionClearedReason = s.selectionClearedReason
          let changed = false
          for (const { ref, flags } of entries) {
            // A tombstoned mail stays gone: a relay replaying an older
            // non-delete version (or a kind-34578 written before the delete)
            // must not re-create its flags entry. Same guard as addEmail.
            if (deletedIds.has(ref)) continue
            const prev = mailState[ref]
            // Newest wins. An optimistic local write stamps `updatedAt` with now, so
            // a replay of an older relay version (or one it just echoed back) can't
            // overwrite it.
            if (prev && prev.updatedAt > flags.updatedAt) continue
            changed = true
            if (flags.deleted) {
              // Another device deleted this mail: purge it here too. Tombstoning
              // matters as much as removing the entry — a relay that ignored the
              // kind-5 will happily serve the wrap again on the next fetch.
              // The `deletedIds` tombstone is the durable record; the per-mail
              // flags entry is dropped so storage does not grow with a second
              // copy of every deletion (D14).
              delete mailState[ref]
              deletedIds = new Set(deletedIds)
              deletedIds.add(ref)
              if (ref in wrapKeys) {
                wrapKeys = { ...wrapKeys }
                delete wrapKeys[ref]
              }
              delete emails[ref]
              if (selectedId === ref) {
                selectedId = null
                selectionClearedReason = 'deleted'
              }
              continue
            }
            mailState[ref] = flags
            const email = emails[ref]
            if (email && email.read !== !!flags.read) emails[ref] = { ...email, read: !!flags.read }
            // Archived/trashed are deliberately NOT mirrored onto the email
            // entry: `mailState` is the single source of truth for filing, and
            // `EmailList` derives the folder from these flags via isFiled (D2).
          }
          if (!changed) return s
          return { mailState, emails, deletedIds, wrapKeys, selectedId, selectionClearedReason }
        }),

      saveWrapKey: (id, wrapKey) => {
        if (get().wrapKeys[id] === wrapKey) return
        set((s) => ({ wrapKeys: { ...s.wrapKeys, [id]: wrapKey } }))
      },

      markDeleted: (id) => {
        const merged: MailFlags = {
          ...get().mailState[id],
          deleted: true,
          updatedAt: Math.floor(Date.now() / 1000),
        }
        set((s) => {
          const deletedIds = new Set(s.deletedIds)
          deletedIds.add(id)

          const wrapKeys = { ...s.wrapKeys }
          delete wrapKeys[id]

          // The merged flags are returned for publishing, not stored: the
          // tombstone set is the durable local record and keeping a flags
          // entry per deleted mail would grow storage forever (D14).
          const mailState = { ...s.mailState }
          delete mailState[id]

          const emails = { ...s.emails }
          delete emails[id]
          // `seenIds` deliberately keeps the id: a relay replaying the wrap must
          // not pay a signer round-trip only for addEmail's tombstone guard to
          // drop the result — the onEvent pre-checks catch it first.
          return {
            deletedIds,
            wrapKeys,
            mailState,
            emails,
            selectedId: s.selectedId === id ? null : s.selectedId,
          }
        })
        return merged
      },

      // Switching folders clears the search too: a query typed against Inbox
      // almost never means the same thing in Trash, and carrying it over silently
      // hides mail the user just asked to see.
      setFolder: (folder) => set({ folder, selectedId: null, query: '', selectionClearedReason: null }),
      setSelected: (id) => set({ selectedId: id, selectionClearedReason: null }),
      setQuery: (query) => set({ query }),
      clearSelectionClearedReason: () => set({ selectionClearedReason: null }),
      setSyncError: (message) => set({ syncError: message }),

      // Changing the visible alias also drops the open message and any search —
      // both were scoped to the previous view and rarely mean the same thing here.
      // `keepSelection` is for the composer's app-wide From switcher: it mirrors the
      // choice into the sidebar highlight without yanking away the email the user
      // is mid-compose against. Navigation from the sidebar still clears.
      setInboxFilter: (address, keepSelection) =>
        set(
          keepSelection
            ? { inboxFilter: address ? address.toLowerCase() : null }
            : { inboxFilter: address ? address.toLowerCase() : null, selectedId: null, query: '' },
        ),

      // Wipe everything account-scoped when switching users. `mailState` is keyed by
      // gift-wrap id (globally unique, so it never collides across accounts) and
      // persisted per device, so it deliberately survives — mail opened or filed
      // under one account keeps that state if it ever appears under another, and its
      // offline cache stays warm across a switch.
      clear: () =>
        set({
          emails: {},
          seenIds: new Set(),
          seenMetaIds: new Set(),
          selectedId: null,
          folder: 'inbox',
          query: '',
          inboxFilter: null,
          selectionClearedReason: null,
          syncError: null,
        }),
    }),
    {
      // THREE storage keys, same names and bare-value shapes the hand-rolled
      // helpers wrote, so existing devices upgrade in place and a rollback to
      // the old build keeps working. The persist middleware writes a single
      // `name` key, so instead of an envelope the custom storage below SPLITS
      // the persisted state across the three keys (getItem merges them back).
      // The legacy read-set fold happens in migrate (first hydration).
      name: 'mailstr.mailstore.v1',
      version: 1,
      storage: mailStorage,
      partialize: (s) => ({
        mailState: s.mailState,
        wrapKeys: s.wrapKeys,
        deletedIds: [...s.deletedIds],
      }),
      // The storage round-trips deletedIds as a string[] (the legacy shape);
      // merge converts it back into the Set the store works with and folds
      // the legacy `mailstr.read` set in (runs on EVERY hydration, unlike
      // migrate, so a device upgraded from the pre-persist build keeps its
      // read state).
      merge: (persisted, current) => {
        const slices = (persisted ?? {}) as {
          mailState?: Record<string, MailFlags>
          wrapKeys?: Record<string, string>
          deletedIds?: string[]
        }
        return {
          ...current,
          mailState: foldLegacyReadState(slices.mailState ?? {}),
          wrapKeys: slices.wrapKeys ?? current.wrapKeys,
          deletedIds: new Set(slices.deletedIds ?? []),
        }
      },
      migrate: migratePersisted,
    },
  ),
)
