import { nip19 } from 'nostr-tools'

// Rumor construction, sealing, wrapping and unwrapping all live in the shared
// protocol module (`@protocol`) so the client and the bridge cannot drift into
// incompatible wire formats. Only these two encoding helpers remain here.

export function pubkeyToNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey)
}

export function npubToPubkey(npub: string): string {
  const decoded = nip19.decode(npub)
  if (decoded.type !== 'npub') throw new Error('Not an npub')
  return decoded.data
}
