import { create } from 'zustand'
import type { Email, EmailFolder } from '@/types/mail'

/**
 * Read state, persisted to this device.
 *
 * The store is otherwise in-memory: every fetch rebuilds emails from the wraps
 * with `read: false`, so without this the inbox forgets what you've opened on
 * each reload. We keep the set of opened gift-wrap ids in localStorage and
 * re-apply it as mail comes back in.
 *
 * Deliberately local. A per-message read receipt published to relays would leak
 * who-read-what-and-when to anyone serving them. The gift-wrap id is stable
 * across fetches — and across devices — so if we ever want cross-device read
 * state, the move is to sync *this same set* as a single self-encrypted event
 * (NIP-44 to our own key), not to emit a label per message. That stays an
 * opt-in follow-up; this fixes the local case with no new metadata.
 */
const READ_KEY = 'mailstr.read'

function loadReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY)
    const ids: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    // Blocked/absent storage or malformed JSON — start empty. Read state just
    // won't persist this session, which is a far smaller failure than a crash.
    return new Set()
  }
}

function persistReadIds(ids: Set<string>): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...ids]))
  } catch {
    // Storage refused it — read state still applies in memory for this session.
  }
}

interface MailState {
  emails: Record<string, Email>   // keyed by event ID
  seenIds: Set<string>
  readIds: Set<string>            // opened gift-wrap ids, persisted to this device
  selectedId: string | null
  folder: EmailFolder
  query: string
  addEmail: (email: Email) => void
  markRead: (id: string) => void
  setFolder: (folder: EmailFolder) => void
  setSelected: (id: string | null) => void
  setQuery: (query: string) => void
}

export const useMailStore = create<MailState>()((set, get) => ({
  emails: {},
  seenIds: new Set(),
  readIds: loadReadIds(),
  selectedId: null,
  folder: 'inbox',
  query: '',

  addEmail: (email) => {
    if (get().seenIds.has(email.id)) return
    // Re-apply persisted read state: a freshly fetched wrap arrives read:false,
    // but we may have opened it on a previous load.
    const read = email.read || get().readIds.has(email.id)
    set((s) => ({
      emails: { ...s.emails, [email.id]: { ...email, read } },
      seenIds: new Set([...s.seenIds, email.id]),
    }))
  },

  markRead: (id) =>
    set((s) => {
      const alreadyTracked = s.readIds.has(id)
      const readIds = alreadyTracked ? s.readIds : new Set(s.readIds).add(id)
      if (!alreadyTracked) persistReadIds(readIds)
      const email = s.emails[id]
      const emails =
        email && !email.read ? { ...s.emails, [id]: { ...email, read: true } } : s.emails
      return { readIds, emails }
    }),

  // Switching folders clears the search too: a query typed against Inbox
  // almost never means the same thing in Trash, and carrying it over silently
  // hides mail the user just asked to see.
  setFolder: (folder) => set({ folder, selectedId: null, query: '' }),
  setSelected: (id) => set({ selectedId: id }),
  setQuery: (query) => set({ query }),
}))
