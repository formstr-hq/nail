import { nip19 } from 'nostr-tools'
import { isNpub, isHexPubkey, splitAddress } from '@protocol'
import { probeNip05 } from './nip05'
import { BRIDGE_DOMAIN, BRIDGE_NIP05_NAME } from './constants'
import type { ResolveContext } from '@/lib/mail/resolve'

/**
 * Which bridge relays this user's outbound legacy mail.
 *
 * Defaults to `_smtp@<their own mail domain>`, mirroring SMTP — your outgoing
 * server is the one run by your mailbox provider. The override exists for
 * self-hosters pointing at their own bridge, and accepts an npub, a hex
 * pubkey, a NIP-05 address, or a bare domain (meaning `_smtp@<domain>`).
 *
 * Returns null when nothing resolves; callers must then refuse to send to
 * legacy addresses rather than silently dropping the mail.
 */
export async function resolveBridge(
  ownDomain: string,
  override?: string,
): Promise<string | null> {
  const input = override?.trim()

  if (input) {
    if (isHexPubkey(input)) return input
    if (isNpub(input)) {
      try {
        const decoded = nip19.decode(input)
        return decoded.type === 'npub' ? (decoded.data as string) : null
      } catch {
        return null
      }
    }
    const target = splitAddress(input) ? input : `${BRIDGE_NIP05_NAME}@${input}`
    return probeNip05(target)
  }

  return probeNip05(`${BRIDGE_NIP05_NAME}@${ownDomain}`)
}

/**
 * Everything recipient resolution needs to classify an address, assembled from
 * the signed-in user's own sender address plus any bridge override.
 */
export async function buildResolveContext(
  senderAddress: string,
  bridgeOverride?: string,
): Promise<ResolveContext> {
  const ownDomain = splitAddress(senderAddress)?.domain ?? BRIDGE_DOMAIN
  const localDomains = Array.from(new Set([BRIDGE_DOMAIN, ownDomain]))
  const bridgePubkey = await resolveBridge(ownDomain, bridgeOverride)
  return { localDomains, ownDomain, bridgePubkey }
}
