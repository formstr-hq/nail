import { splitAddress } from '@protocol'
import { apiUrl } from '@/app/lib/api/config'

/**
 * What the sender-proof derivation knows about an address's NIP-05 record.
 *
 * `skipped` means there is nothing to look up (no address-shaped claim, or a
 * `<npub>@…` sender whose ownership is provable from the key itself), so no
 * check is outstanding and none should be implied.
 */
export type Nip05State =
  | { status: 'skipped' }
  | { status: 'resolving' }
  | { status: 'resolved'; pubkey: string | null }

const PROBE_TIMEOUT_MS = 1500
// The bridge's own `_smtp` record is on the critical send path and, unlike a
// recipient probe, times out fail-closed (no bridge = cannot send at all). The
// hosted mailstr.app well-known answers in ~1–2s cold, so the recipient budget
// would routinely lose that race and cache a spurious negative for the session.
export const BRIDGE_PROBE_TIMEOUT_MS = 4000
const NEGATIVE_TTL_MS = 24 * 60 * 60_000
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60_000

type Entry = { pubkey: string | null; expires: number }
const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<string | null>>()

/**
 * How many NIP-05 fetches may be in flight at once.
 *
 * Render-time sender-proof derivation probes every distinct address on screen,
 * and recipient resolution probes every recipient — both can fan out over an
 * arbitrary number of domains at once. The browser would queue the sockets
 * anyway; this bounds the work at the source so the load is explicit, and
 * per-address `inFlight` dedup means repeated callers share one slot.
 */
const MAX_CONCURRENT_PROBES = 4
let activeProbes = 0
const probeWaiters: Array<() => void> = []

function acquireProbeSlot(): Promise<void> {
  if (activeProbes < MAX_CONCURRENT_PROBES) {
    activeProbes += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => probeWaiters.push(resolve))
}

function releaseProbeSlot(): void {
  const next = probeWaiters.shift()
  if (next) {
    // Hand the slot straight to the next waiter — the count stays the same.
    next()
  } else {
    activeProbes -= 1
  }
}

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

/**
 * Is `domain` one of the known-not-Nostr email providers? These never serve a
 * NIP-05 record, so a recipient on one is always delivered through the bridge.
 * Used by the composer's pre-emptive guard to block an npub From only when a
 * recipient is *definitely* legacy — avoiding false positives on NIP-05 names
 * hosted on unfamiliar domains, which resolve directly over Nostr. The
 * authoritative check is in `buildWraps` (via `resolveRecipients`); this is the
 * in-composer preview, so it only fires on the certain case.
 */
export function isKnownLegacyDomain(domain: string): boolean {
  return KNOWN_LEGACY.includes(domain.toLowerCase())
}

function seedNegativeCache(): void {
  for (const domain of KNOWN_LEGACY) {
    cache.set(`__domain__:${domain}`, { pubkey: null, expires: Infinity })
  }
}
seedNegativeCache()

export function clearProbeCache(): void {
  cache.clear()
  inFlight.clear()
  // In-flight fetches keep their slots until they settle (their `finally`
  // releases them and their now-dropped result is discarded), so the slot
  // accounting stays consistent and parked waiters drain normally.
  seedNegativeCache()
}

/**
 * The cached outcome for `address`, if one is fresh — no fetch, no side
 * effect. Render-time consumers (sender-proof derivation) use this to answer
 * synchronously on repeat renders and only kick off `probeNip05` on a miss,
 * so a cached negative never flashes "checking" again.
 */
export function peekNip05(address: string): { pubkey: string | null } | null {
  const parts = splitAddress(address)
  if (!parts) return null
  const domainEntry = cache.get(`__domain__:${parts.domain}`)
  if (domainEntry && domainEntry.expires > Date.now()) return { pubkey: null }
  const cached = cache.get(`${parts.localpart}@${parts.domain}`)
  if (cached && cached.expires > Date.now()) return { pubkey: cached.pubkey }
  return null
}

/**
 * The backend resolver, for addresses whose own domain serves no well-known.
 *
 * A workspace (tenant) domain has no web presence at all, so the direct probe
 * above can never succeed for it. The backend already holds those records and
 * exposes them at `/api/nip-05/resolve` — the same endpoint the bridge uses.
 *
 * Returns `undefined` when the fallback could not be consulted (network error,
 * non-OK status), which callers must treat as "unknown", NOT as "not Nostr".
 * The distinction matters on the routing path: a negative here sends mail
 * through the legacy bridge instead of Nostr-direct.
 */
async function probeResolver(address: string, timeoutMs: number): Promise<string | null | undefined> {
  try {
    const res = await fetch(
      apiUrl(`/api/nip-05/resolve?address=${encodeURIComponent(address)}`),
      { signal: AbortSignal.timeout(timeoutMs) },
    )
    if (res.status === 404) return null
    if (!res.ok) return undefined
    const json = (await res.json()) as { pubkey?: string }
    return typeof json.pubkey === 'string' ? json.pubkey : null
  } catch {
    return undefined
  }
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
 *
 * When the domain's own well-known does not answer, the backend resolver gets
 * a turn — that is the only path that works for workspace domains.
 */
export async function probeNip05(
  address: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<string | null> {
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
    await acquireProbeSlot()
    try {
      // A domain that serves a usable NIP-05 document is authoritative: a hit
      // resolves, a miss is a definitive no. Deliberately no resolver call
      // here — it would leak every typed recipient to our backend, and a
      // domain that answers does not need it.
      try {
        const res = await fetch(
          `https://${parts.domain}/.well-known/nostr.json?name=${encodeURIComponent(parts.localpart)}`,
          { signal: AbortSignal.timeout(timeoutMs) },
        )
        if (res.ok) {
          const json = (await res.json()) as { names?: Record<string, string> }
          return json.names?.[parts.localpart] ?? null
        }
      } catch {
        // Unreachable: fall through to the resolver — this is the tenant case.
      }
      // No usable well-known. The backend resolver is the only other source,
      // and it is the one that knows workspace addresses.
      const viaResolver = await probeResolver(address, timeoutMs)
      return viaResolver ?? null
    } finally {
      releaseProbeSlot()
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
