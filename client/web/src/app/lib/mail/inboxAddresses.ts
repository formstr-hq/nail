/**
 * Pure addressing/index helpers for the compact sidebar.
 *
 * The sidebar must stay useful whether an account owns two addresses or two
 * hundred. These functions own the stable rules — pin ordering, domain
 * grouping, and the "recently active" shortlist — so the components only have
 * to render the result.
 */

/** Below this many addresses, the familiar flat list is still fine. */
export const SHOW_ALL_INBOXES_LIMIT = 5

/** Keep the always-visible sidebar short; the picker is the full list. */
export const PINNED_INBOX_LIMIT = 5

/** Recently-active addresses shown inside the picker. */
export const RECENT_INBOX_LIMIT = 3

export interface AliasInboxStats {
  /** Unread Inbox messages addressed to this alias. */
  unread: number
  /** Unix seconds of the newest message involving this alias, or 0. */
  lastAt: number
}

const keyOf = (address: string) => address.trim().toLowerCase()

/**
 * Resolve persisted pins against the addresses that still exist.
 *
 * Storage is case-insensitive and may outlive a renamed address, so:
 * - pins whose address is gone are dropped;
 * - duplicates are collapsed;
 * - the result carries the display casing of the live address;
 * - the user's pin order is preserved.
 */
export function normalizePinnedInboxes(
  pinned: readonly string[] | undefined,
  aliases: readonly string[],
): string[] {
  if (!pinned?.length || !aliases.length) return []
  const byKey = new Map(aliases.map((address) => [keyOf(address), address]))
  const seen = new Set<string>()
  const result: string[] = []
  for (const pin of pinned) {
    const key = keyOf(pin)
    if (!key || seen.has(key)) continue
    const address = byKey.get(key)
    if (!address) continue
    seen.add(key)
    result.push(address)
    if (result.length >= PINNED_INBOX_LIMIT) break
  }
  return result
}

export function isPinnedInbox(pinned: readonly string[], address: string): boolean {
  const key = keyOf(address)
  return pinned.some((pin) => keyOf(pin) === key)
}

export interface AddressGroup {
  domain: string
  addresses: string[]
}

/**
 * Group addresses by domain for the picker. Domains and addresses are sorted
 * case-insensitively so the full list stays predictable even as it grows.
 */
export function groupAddressesByDomain(addresses: readonly string[]): AddressGroup[] {
  const groups = new Map<string, string[]>()
  for (const address of addresses) {
    const at = address.lastIndexOf('@')
    const domain = at >= 0 ? address.slice(at + 1).trim() : ''
    const list = groups.get(domain)
    if (list) list.push(address)
    else groups.set(domain, [address])
  }

  const byName = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })

  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (!a && b) return 1
      if (a && !b) return -1
      return byName(a, b)
    })
    .map(([domain, list]) => ({ domain, addresses: [...list].sort(byName) }))
}

/**
 * The picker's "Recently active" shortlist: addresses with actual mail
 * activity, newest first, excluding anything already shown elsewhere (pins and
 * the current address). Ties break alphabetically so the order does not flicker.
 */
export function recentInboxes(
  aliases: readonly string[],
  stats: ReadonlyMap<string, AliasInboxStats>,
  exclude: ReadonlySet<string>,
  limit = RECENT_INBOX_LIMIT,
): string[] {
  return aliases
    .filter((address) => {
      const key = keyOf(address)
      if (exclude.has(key)) return false
      return (stats.get(key)?.lastAt ?? 0) > 0
    })
    .sort((a, b) => {
      const aStats = stats.get(keyOf(a))
      const bStats = stats.get(keyOf(b))
      const byRecent = (bStats?.lastAt ?? 0) - (aStats?.lastAt ?? 0)
      return byRecent || a.localeCompare(b, undefined, { sensitivity: 'base' })
    })
    .slice(0, limit)
}
