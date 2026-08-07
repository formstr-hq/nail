import type { Email, MailAddress } from '@/types/mail'

/** A correspondent derived from the addresses on decoded mail. */
export interface Contact {
  /** Lowercased address — the dedup key. */
  key: string
  /** Address as first seen (original case), used when inserting into a draft. */
  address: string
  /** Best-known display name, if any message carried one. */
  name?: string
  /** How many messages reference this address (drives ranking). */
  count: number
  /** Latest message timestamp involving them, unix seconds (tiebreak + recency). */
  lastSeen: number
}

/**
 * Build a deduped, ranked contact list from the `from`/`to`/`cc` fields of every
 * decoded email. Everything is already local — this never touches the network.
 * Your own addresses are excluded so the picker never suggests you to yourself.
 */
export function deriveContacts(emails: Email[], selfAddresses: string[] = []): Contact[] {
  const self = new Set(selfAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean))
  const byKey = new Map<string, Contact>()

  const add = (addr: MailAddress | undefined, ts: number) => {
    const address = addr?.address?.trim()
    if (!address) return
    const key = address.toLowerCase()
    if (self.has(key)) return
    const name = addr!.name?.trim() || undefined
    const existing = byKey.get(key)
    if (existing) {
      existing.count += 1
      if (ts > existing.lastSeen) existing.lastSeen = ts
      // Keep the first real name we see; a later bare-address mention shouldn't
      // wipe a name we already have.
      if (!existing.name && name) existing.name = name
    } else {
      byKey.set(key, { key, address, name, count: 1, lastSeen: ts })
    }
  }

  for (const e of emails) {
    add(e.from, e.timestamp)
    for (const t of e.to) add(t, e.timestamp)
    for (const c of e.cc ?? []) add(c, e.timestamp)
  }

  // Most-mailed first, then most-recent — the people you actually write to float
  // to the top of the picker.
  return Array.from(byKey.values()).sort(
    (a, b) => b.count - a.count || b.lastSeen - a.lastSeen,
  )
}

/**
 * Filter a ranked contact list by a query against name or address. An empty
 * query returns the top contacts (recent recipients), so focusing an empty field
 * still offers something useful.
 */
export function searchContacts(contacts: Contact[], query: string, limit = 6): Contact[] {
  const q = query.trim().toLowerCase()
  const matched = q
    ? contacts.filter(
        (c) => c.address.toLowerCase().includes(q) || (c.name?.toLowerCase().includes(q) ?? false),
      )
    : contacts
  return matched.slice(0, limit)
}
