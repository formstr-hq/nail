import type { Email } from '@/app/types/mail'

/**
 * Does this message belong to a given one of the account's addresses?
 *
 * Every message arrives at the single Nostr key regardless of which alias it
 * was addressed to, so the split is a client-side view over one stream. A
 * `null` filter means "all mail". Otherwise we match the alias (already
 * lowercased by the store) against the addresses a message actually carries:
 * `to`/`cc` catch incoming mail sent to that alias, and the effective sender
 * catches our own sent copies written from it — so the same filter works in
 * every folder.
 *
 * The sender compared here is the EFFECTIVE one (header when backed, key when
 * not), because a spoofed header must not let a stranger's mail file itself
 * under one of the user's aliases.
 */
export function matchesAlias(
  email: Email,
  filter: string | null,
  effectiveFrom: { address: string } = email.fromHeader,
): boolean {
  if (!filter) return true
  const addresses = [
    ...email.to.map((a) => a.address),
    ...(email.cc ?? []).map((a) => a.address),
    effectiveFrom.address,
  ]
  return addresses.some((a) => a.toLowerCase() === filter)
}
