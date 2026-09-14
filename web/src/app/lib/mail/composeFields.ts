import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import { isNpub, splitAddress } from '@protocol'
import { isKnownLegacyDomain } from '@/app/lib/nostr/nip05'
import type { ResolveContext } from '@/app/lib/mail/resolve'

/**
 * Split a comma-separated recipient string into its committed part + the token
 * currently being typed (everything after the last comma).
 */
export function splitRecipients(value: string): { head: string; token: string } {
  const lastComma = value.lastIndexOf(',')
  if (lastComma === -1) return { head: '', token: value.trimStart() }
  return { head: value.slice(0, lastComma + 1), token: value.slice(lastComma + 1).trimStart() }
}

/**
 * RFC 3676 §4.3 signature delimiter — "-- " on its own line. Receiving
 * clients use it to fold the signature away, so the trailing space matters.
 */
export function signatureBlock(signature: string | undefined): string {
  const trimmed = signature?.trim()
  return trimmed ? `\n\n-- \n${trimmed}` : ''
}

/** Comma-separated string → trimmed recipient list, duplicate addresses (case-
 *  insensitive) dropped. Dedup happens here at the source, and again on
 *  resolved pubkeys in send.ts, so a repeated address or a To+Cc overlap
 *  cannot produce duplicate delivery. */
export function parseRecipients(to: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of to.split(',')) {
    const address = raw.trim()
    if (!address) continue
    const key = address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(address)
  }
  return out
}

/** The user's npub address (`<npub>@<bridge domain>`), or '' when signed out. */
export function defaultNpubAddress(accountNpub: string | undefined): string {
  return accountNpub ? `${accountNpub}@${BRIDGE_DOMAIN}` : ''
}

/**
 * App-wide From, fully derived from the inbox the user is viewing (the
 * sidebar's active alias), falling back to the saved sender address, then an
 * owned alias, then the npub. Deriving it — rather than seeding a `useState`
 * once at mount — is the fix for the composer/sidebar handle mismatch:
 * `selfAddresses` (owned addresses), `settings.senderAddress`, and
 * `inboxFilter` all resolve/change *after* the composer opens, and a frozen
 * seed left the From showing a different handle than the sidebar. An explicit
 * pick writes through to `inboxFilter` (the select's onChange, silent
 * setter), so this expression tracks the user's choice too and the two never
 * disagree. It is the npub that used to silently bounce off the bridge; the
 * composer's guard blocks that. An alias is preferred over the npub as the bare
 * default because the npub bounces at the bridge for legacy recipients while
 * an alias works for both — an explicit npub pick (switcher → inboxFilter, or
 * saved sender) still wins via the branches above.
 */
export function deriveFromAddress(input: {
  inboxFilter: string | null
  selfAddresses: string[]
  senderAddress?: string
  ownedAliases: string[]
  defaultAddress: string
}): string {
  if (input.inboxFilter) {
    const match = input.selfAddresses.find((a) => a.toLowerCase() === input.inboxFilter)
    if (match) return match
  }
  if (input.senderAddress) return input.senderAddress
  if (input.ownedAliases.length > 0) return input.ownedAliases[0]
  return input.defaultAddress || input.selfAddresses[0] || ''
}

/**
 * Selected alias first, the rest in selfAddresses order (npub next, then
 * owned aliases) — so the dropdown leads with the active sender.
 */
export function deriveFromOptions(selfAddresses: string[], fromAddress: string): string[] {
  const rest = selfAddresses.filter((a) => a.toLowerCase() !== fromAddress.toLowerCase())
  return fromAddress ? [fromAddress, ...rest] : rest
}

/**
 * An npub From is a valid sender for anything reached directly over Nostr
 * (npubs, and NIP-05 names on any nostr-native domain) but NOT for recipients
 * the bridge delivers — external email addresses, which only accept a
 * registered alias sender. Replay that rule client-side so the user gets a
 * clear message instead of a postmaster bounce. The bridge set is only known
 * for sure after resolving recipients (send.ts does that authoritatively);
 * here we pre-block only on the *definite* case — a recipient on a known
 * legacy email domain — so NIP-05 names on unfamiliar domains are never
 * falsely flagged. Anything ambiguous is left to send.ts, which surfaces its
 * own error on Send.
 */
export function hasKnownLegacyRecipient(
  recipients: string[],
  localDomains: ResolveContext['localDomains'],
): boolean {
  return recipients.some((r) => {
    const parts = splitAddress(r)
    return !!parts && !localDomains.includes(parts.domain) && isKnownLegacyDomain(parts.domain)
  })
}

/** The actionable half of every alias-limitation notice: switch to an alias
 *  you already own, or go buy one. Shared by the pre-send npub guard and the
 *  send-time bounce banner so both are actionable, not just explanatory. */
export function isNpubSender(fromAddress: string): boolean {
  const parts = splitAddress(fromAddress)
  return !!parts && isNpub(parts.localpart)
}