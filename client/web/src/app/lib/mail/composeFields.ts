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

/**
 * Can this address actually send mail? The npub mailbox is receive-only in
 * every path that matters: the bridge rejects it as a sender for external
 * recipients (no NIP-05 row) and it cannot hold a PGP key, so offering it in
 * the From picker only produces a bounce or an unencrypted send. The composer
 * filters it out completely instead of letting the user pick a dead sender.
 */
export function isSendableAddress(address: string | undefined): boolean {
  if (!address) return false
  return !isNpub(address.trim()) && !isNpubSender(address)
}

/** The self address matching `address` (case-insensitively), if it is one that
 *  can send. Returns the owned spelling so the select value matches an option. */
function ownedSendable(address: string | undefined, selfAddresses: string[]): string | undefined {
  if (!address) return undefined
  const match = selfAddresses.find((a) => a.toLowerCase() === address.toLowerCase())
  return match && isSendableAddress(match) ? match : undefined
}

/**
 * The composer's From.
 *
 * A reply pins the account address the original message was delivered to
 * (`preferredFrom`) — that is the identity the correspondent wrote to, and it
 * must win over whatever inbox happens to be selected in the sidebar. Without
 * a reply pin, the From follows the active inbox, then an owned alias, then
 * any other sendable self address. The npub is never a
 * candidate: it cannot send through the bridge and cannot hold a key, so a
 * user who only has an npub gets no From until they buy an alias.
 */
export function deriveFromAddress(input: {
  preferredFrom?: string
  inboxFilter: string | null
  selfAddresses: string[]
  ownedAliases: string[]
}): string {
  const preferred = ownedSendable(input.preferredFrom, input.selfAddresses)
  if (preferred) return preferred

  const sendable = input.selfAddresses.filter(isSendableAddress)
  if (input.inboxFilter) {
    const match = sendable.find((a) => a.toLowerCase() === input.inboxFilter)
    if (match) return match
  }
  const alias = input.ownedAliases.find(isSendableAddress)
  if (alias) return alias
  return sendable[0] ?? ''
}

/**
 * Selected alias first, the rest in selfAddresses order — so the dropdown
 * leads with the active sender. The npub is filtered out: it is not a usable
 * From (see isSendableAddress).
 */
export function deriveFromOptions(selfAddresses: string[], fromAddress: string): string[] {
  const sendable = selfAddresses.filter(isSendableAddress)
  const rest = sendable.filter((a) => a.toLowerCase() !== fromAddress.toLowerCase())
  return isSendableAddress(fromAddress) ? [fromAddress, ...rest] : rest
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