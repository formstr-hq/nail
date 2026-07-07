import { resolveNip05, resolveBridgePubkey, isNpub, isHexPubkey, isLegacyEmail } from '@/lib/nostr/nip05'
import { npubToPubkey } from '@/lib/nostr/giftwrap'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'

export type RecipientType = 'nostr' | 'bridge'

export interface ResolvedRecipient {
  type: RecipientType
  pubkey: string        // hex pubkey to gift-wrap to
  address: string       // original address string (for RFC 2822 headers)
}

export async function resolveRecipient(address: string): Promise<ResolvedRecipient> {
  // 1. Direct npub
  if (isNpub(address)) {
    return { type: 'nostr', pubkey: npubToPubkey(address), address }
  }

  // 2. Hex pubkey
  if (isHexPubkey(address)) {
    return { type: 'nostr', pubkey: address, address }
  }

  // 3. NIP-05 or legacy email
  if (address.includes('@')) {
    const domain = address.split('@')[1]

    // Try NIP-05 first (even for addresses that look like legacy emails)
    const nip05Pubkey = await resolveNip05(address)
    if (nip05Pubkey) {
      return { type: 'nostr', pubkey: nip05Pubkey, address }
    }

    // If domain is the bridge domain, treat as bridge-routed Nostr
    if (domain === BRIDGE_DOMAIN) {
      const bridgePubkey = await resolveBridgePubkey()
      if (!bridgePubkey) throw new Error('Could not resolve bridge pubkey')
      return { type: 'bridge', pubkey: bridgePubkey, address }
    }

    // Legacy email — route to bridge
    if (isLegacyEmail(address)) {
      const bridgePubkey = await resolveBridgePubkey()
      if (!bridgePubkey) throw new Error('Could not resolve bridge pubkey')
      return { type: 'bridge', pubkey: bridgePubkey, address }
    }
  }

  throw new Error(`Cannot resolve recipient: ${address}`)
}
