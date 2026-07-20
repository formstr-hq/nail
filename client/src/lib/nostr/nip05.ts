import { splitAddress } from '@protocol'

const PROBE_TIMEOUT_MS = 1500
const NEGATIVE_TTL_MS = 24 * 60 * 60_000
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60_000

type Entry = { pubkey: string | null; expires: number }
const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<string | null>>()

/**
 * Domains known not to serve NIP-05.
 *
 * Seeded into the cache rather than used as a routing rule. A maintained
 * "these are legacy" routing list can only ever cover a handful of the
 * thousands of real mail domains, so the general case pays the probe anyway —
 * and a stale entry would misroute mail permanently. As a cache seed, a stale
 * entry costs exactly one probe.
 */
const KNOWN_LEGACY = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'proton.me', 'protonmail.com', 'icloud.com', 'me.com', 'aol.com',
]

function seedNegativeCache(): void {
  for (const domain of KNOWN_LEGACY) {
    cache.set(`__domain__:${domain}`, { pubkey: null, expires: Infinity })
  }
}
seedNegativeCache()

export function clearProbeCache(): void {
  cache.clear()
  inFlight.clear()
  seedNegativeCache()
}

/**
 * Look up an address via NIP-05, bounded and cached.
 *
 * The timeout is fail-safe rather than fail-open: on timeout this resolves to
 * null and the caller routes to the bridge, so the worst case is a detour
 * through legacy email instead of a hung compose window.
 *
 * CORS failure, 404 and `{"names":{}}` are all "not Nostr-native here" for
 * routing purposes, so they share a return value — but only negatives get the
 * short TTL, so a transient network blip cannot mark a domain legacy forever.
 */
export async function probeNip05(address: string): Promise<string | null> {
  const parts = splitAddress(address)
  if (!parts) return null

  const domainEntry = cache.get(`__domain__:${parts.domain}`)
  if (domainEntry && domainEntry.expires > Date.now()) return null

  const key = `${parts.localpart}@${parts.domain}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.pubkey

  const pending = inFlight.get(key)
  if (pending) return pending

  const query = (async (): Promise<string | null> => {
    try {
      const res = await fetch(
        `https://${parts.domain}/.well-known/nostr.json?name=${encodeURIComponent(parts.localpart)}`,
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      )
      if (!res.ok) return null
      const json = (await res.json()) as { names?: Record<string, string> }
      return json.names?.[parts.localpart] ?? null
    } catch {
      return null
    }
  })()
    .then((pubkey) => {
      cache.set(key, {
        pubkey,
        expires: Date.now() + (pubkey ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
      })
      return pubkey
    })
    .finally(() => inFlight.delete(key))

  inFlight.set(key, query)
  return query
}
