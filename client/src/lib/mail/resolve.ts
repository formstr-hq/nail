import { resolveNip05, resolveBridgePubkey, isNpub, isHexPubkey, isLegacyEmail } from '@/lib/nostr/nip05'
import { npubToPubkey, pubkeyToNpub } from '@/lib/nostr/giftwrap'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'

export type RecipientType = 'nostr' | 'bridge'

export interface ResolvedRecipient {
  type: RecipientType
  pubkey: string        // hex pubkey to gift-wrap to
  address: string       // original address string, as the user typed it
  headerAddress: string // valid RFC 2822 addr-spec for To:/CC: headers
}

/**
 * A bare npub or hex pubkey is not a valid RFC 2822 addr-spec, and a parser
 * reading `To: npub1…` back treats the whole thing as a display *name* with an
 * empty address — which is why such recipients rendered blank. Write the
 * documented bridge form `<npub>@<BRIDGE_DOMAIN>` into headers instead.
 */
function nostrHeaderAddress(pubkey: string): string {
  return `${pubkeyToNpub(pubkey)}@${BRIDGE_DOMAIN}`
}

export async function resolveRecipient(address: string): Promise<ResolvedRecipient> {
  // 1. Direct npub
  if (isNpub(address)) {
    const pubkey = npubToPubkey(address)
    return { type: 'nostr', pubkey, address, headerAddress: nostrHeaderAddress(pubkey) }
  }

  // 2. Hex pubkey
  if (isHexPubkey(address)) {
    return { type: 'nostr', pubkey: address, address, headerAddress: nostrHeaderAddress(address) }
  }

  // 3. NIP-05 or legacy email
  if (address.includes('@')) {
    const [localPart, domain] = address.split('@')

    // `<npub>@<domain>` — the form we write into headers for Nostr-native
    // recipients. Resolve it straight back to the pubkey; without this a reply
    // would fall through to the bridge branch below and be relayed as legacy
    // email instead of going direct.
    if (isNpub(localPart)) {
      const pubkey = npubToPubkey(localPart)
      return { type: 'nostr', pubkey, address, headerAddress: nostrHeaderAddress(pubkey) }
    }

    // Try NIP-05 first (even for addresses that look like legacy emails)
    const nip05Pubkey = await resolveNip05(address)
    if (nip05Pubkey) {
      return { type: 'nostr', pubkey: nip05Pubkey, address, headerAddress: address }
    }

    // If domain is the bridge domain, treat as bridge-routed Nostr
    if (domain === BRIDGE_DOMAIN) {
      const bridgePubkey = await resolveBridgePubkey()
      if (!bridgePubkey) throw new Error('Could not resolve bridge pubkey')
      return { type: 'bridge', pubkey: bridgePubkey, address, headerAddress: address }
    }

    // Legacy email — route to bridge
    if (isLegacyEmail(address)) {
      const bridgePubkey = await resolveBridgePubkey()
      if (!bridgePubkey) throw new Error('Could not resolve bridge pubkey')
      return { type: 'bridge', pubkey: bridgePubkey, address, headerAddress: address }
    }
  }

  throw new Error(`Cannot resolve recipient: ${address}`)
}
