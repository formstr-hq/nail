import { create } from 'zustand'
import type { Email, EmailFolder } from '@/types/mail'

interface MailState {
  emails: Record<string, Email>   // keyed by event ID
  seenIds: Set<string>
  selectedId: string | null
  folder: EmailFolder
  addEmail: (email: Email) => void
  markRead: (id: string) => void
  setFolder: (folder: EmailFolder) => void
  setSelected: (id: string | null) => void
}

export const useMailStore = create<MailState>()((set, get) => ({
  emails: {},
  seenIds: new Set(),
  selectedId: null,
  folder: 'inbox',

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

  setFolder: (folder) => set({ folder, selectedId: null }),
  setSelected: (id) => set({ selectedId: id }),
}))
