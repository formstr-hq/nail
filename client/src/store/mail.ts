import { create } from 'zustand'
import type { Email, EmailFolder } from '@/types/mail'

interface MailState {
  emails: Record<string, Email>   // keyed by event ID
  seenIds: Set<string>
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
  selectedId: null,
  folder: 'inbox',
  query: '',

  addEmail: (email) => {
    if (get().seenIds.has(email.id)) return
    set((s) => ({
      emails: { ...s.emails, [email.id]: email },
      seenIds: new Set([...s.seenIds, email.id]),
    }))
  },

  markRead: (id) =>
    set((s) => ({
      emails: s.emails[id]
        ? { ...s.emails, [id]: { ...s.emails[id], read: true } }
        : s.emails,
    })),

  // Switching folders clears the search too: a query typed against Inbox
  // almost never means the same thing in Trash, and carrying it over silently
  // hides mail the user just asked to see.
  setFolder: (folder) => set({ folder, selectedId: null, query: '' }),
  setSelected: (id) => set({ selectedId: id }),
  setQuery: (query) => set({ query }),
}))
