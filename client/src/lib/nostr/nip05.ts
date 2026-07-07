import { BRIDGE_DOMAIN, BRIDGE_NIP05_NAME } from './constants'

export async function resolveNip05(identifier: string): Promise<string | null> {
  const [name, domain] = identifier.split('@')
  if (!name || !domain) return null

  try {
    const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${name}`)
    if (!res.ok) return null
    const json = await res.json() as { names?: Record<string, string> }
    return json.names?.[name] ?? null
  } catch {
    return null
  }
}

export async function resolveBridgePubkey(): Promise<string | null> {
  return resolveNip05(`${BRIDGE_NIP05_NAME}@${BRIDGE_DOMAIN}`)
}

export function isLegacyEmail(address: string): boolean {
  if (!address.includes('@')) return false
  const domain = address.split('@')[1]
  // Treat as legacy if it's not a known Nostr-native domain
  // (A real implementation could check for NIP-05 existence)
  return domain !== 'nostr' && !address.startsWith('npub1')
}

export function isNpub(value: string): boolean {
  return value.startsWith('npub1') && value.length === 63
}

export function isHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}
