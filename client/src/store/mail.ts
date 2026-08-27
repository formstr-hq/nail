import { create } from 'zustand'
import type { Email, EmailFolder, MailFlags } from '@/types/mail'

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
 */
const STATE_KEY = 'mailstr.mailstate.v1'
// The pre-sync build kept only a set of opened gift-wrap ids here. Fold it into
// the new map on first load so nobody's read state resets on upgrade.
const LEGACY_READ_KEY = 'mailstr.read'

function loadMailState(): Record<string, MailFlags> {
  const state: Record<string, MailFlags> = {}
  try {
    const raw = localStorage.getItem(STATE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object') {
      for (const [id, flags] of Object.entries(parsed as Record<string, MailFlags>)) {
        if (flags && typeof flags === 'object') state[id] = flags
      }
    }
  } catch {
    // Blocked/absent storage or malformed JSON — start empty. State just won't
    // persist this session, a far smaller failure than a crash.
  }
  try {
    const rawLegacy = localStorage.getItem(LEGACY_READ_KEY)
    const ids: unknown = rawLegacy ? JSON.parse(rawLegacy) : []
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === 'string' && !state[id]) state[id] = { read: true, updatedAt: 0 }
      }
    }
  } catch {
    // Ignore a malformed legacy value.
  }
  return state
}

function persistMailState(state: Record<string, MailFlags>): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // Storage refused it — state still applies in memory for this session.
  }
}

/** True when the mail is filed away (archived or trashed), so it leaves Inbox. */
export function isFiled(flags: MailFlags | undefined): boolean {
  return !!(flags?.archived || flags?.trashed)
}

/**
 * Message-IDs compare unreliably across the wire — the header form is `<id@host>`
 * but postal-mime hands back the value with the angle brackets stripped. Normalise
 * to the bare id before matching a bridge receipt to a Sent copy.
 */
export function normalizeMessageId(id: string | undefined): string {
  return (id ?? '').trim().replace(/^</, '').replace(/>$/, '')
}

interface MailState {
  emails: Record<string, Email>   // keyed by event ID
  seenIds: Set<string>
  mailState: Record<string, MailFlags> // read/archived/trashed by gift-wrap id
  // Normalised Message-IDs the bridge has confirmed delivered this session. In
  // memory only and deliberately so — a delivery receipt is an ephemeral gift
  // wrap (relays don't persist it), so the marker is a best-effort live signal,
  // not durable state. Keyed by Message-ID because that is the one identifier
  // shared between the bridge wrap and our Sent self-copy.
  deliveredMessageIds: Set<string>
  selectedId: string | null
  folder: EmailFolder
  query: string
  // Which of the account's own addresses to show mail for, lowercased, or
  // `null` for "all mail". Every message still arrives at the one Nostr key;
  // this filters the view by which alias it was addressed from/to.
  inboxFilter: string | null
  addEmail: (email: Email) => void
  /** Record a bridge delivery receipt so the matching Sent message shows delivered. */
  markDelivered: (messageId: string | undefined) => void
  /** Merge a delta into a mail's flags and return the merged set for publishing. */
  setFlag: (id: string, patch: Partial<Omit<MailFlags, 'updatedAt'>>) => MailFlags
  /** Apply state learned from the relay, newest-wins by `updatedAt`. */
  hydrateFlags: (entries: { ref: string; flags: MailFlags }[]) => void
  setFolder: (folder: EmailFolder) => void
  setSelected: (id: string | null) => void
  setQuery: (query: string) => void
  setInboxFilter: (address: string | null, keepSelection?: boolean) => void
  clear: () => void
}

export const useMailStore = create<MailState>()((set, get) => ({
  emails: {},
  seenIds: new Set(),
  mailState: loadMailState(),
  deliveredMessageIds: new Set(),
  selectedId: null,
  folder: 'inbox',
  query: '',
  inboxFilter: null,

  addEmail: (email) => {
    if (get().seenIds.has(email.id)) return
    // Re-apply known state: a freshly fetched wrap arrives read:false, but we
    // may have opened (or filed) it before, here or on another device.
    const read = email.read || !!get().mailState[email.id]?.read
    set((s) => ({
      emails: { ...s.emails, [email.id]: { ...email, read } },
      seenIds: new Set([...s.seenIds, email.id]),
    }))
  },

  markDelivered: (messageId) => {
    const id = normalizeMessageId(messageId)
    if (!id || get().deliveredMessageIds.has(id)) return
    set((s) => ({ deliveredMessageIds: new Set([...s.deliveredMessageIds, id]) }))
  },

  setFlag: (id, patch) => {
    const prev = get().mailState[id]
    const merged: MailFlags = { ...prev, ...patch, updatedAt: Math.floor(Date.now() / 1000) }
    set((s) => {
      const mailState = { ...s.mailState, [id]: merged }
      persistMailState(mailState)
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
      let changed = false
      for (const { ref, flags } of entries) {
        const prev = mailState[ref]
        // Newest wins. An optimistic local write stamps `updatedAt` with now, so
        // a replay of an older relay version (or one it just echoed back) can't
        // overwrite it.
        if (prev && prev.updatedAt > flags.updatedAt) continue
        mailState[ref] = flags
        changed = true
        const email = emails[ref]
        if (email && email.read !== !!flags.read) emails[ref] = { ...email, read: !!flags.read }
      }
      if (!changed) return s
      persistMailState(mailState)
      return { mailState, emails }
    }),

  // Switching folders clears the search too: a query typed against Inbox
  // almost never means the same thing in Trash, and carrying it over silently
  // hides mail the user just asked to see.
  setFolder: (folder) => set({ folder, selectedId: null, query: '' }),
  setSelected: (id) => set({ selectedId: id }),
  setQuery: (query) => set({ query }),

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
      deliveredMessageIds: new Set(),
      selectedId: null,
      folder: 'inbox',
      query: '',
      inboxFilter: null,
    }),
}))
