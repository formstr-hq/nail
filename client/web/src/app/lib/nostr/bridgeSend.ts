import { apiUrl, apiAuthUrl } from '@/app/lib/api/config'
import { buildNip98Header, type Nip98Signer } from '@/lib/nip98'

/**
 * The bridge's HTTP ingest path, an alternative to publishing a gift wrap to
 * Nostr relays and hoping the bridge's subscription catches it.
 *
 * The client first fetches the mail-discovery well-known document
 * (`/.well-known/nostr-mail.json`) to learn the bridge pubkey to seal to and
 * the exact endpoint to POST the client-sealed wrap to. The backend then hands
 * the wrap to the bridge, which feeds it through the identical `handleWrap`
 * path as a relay-delivered one — so delivery no longer depends on the bridge
 * observing our relay publish. Relay publish remains the fallback when
 * discovery or the API call fails (see `deliver`).
 */

export interface MailDiscovery {
  /** Bridge pubkey the wrap must be p-tagged to (also the seal target). */
  bridgePubkey: string
  /** Absolute URL of the backend's send-wrap endpoint. */
  sendWrapEndpoint: string
}

export interface SendWrapResult {
  ok: boolean
  /** 0 means the request never reached the backend (network/timeout). */
  status: number
  reason?: string
}

const DISCOVERY_TIMEOUT_MS = 4000
const SEND_TIMEOUT_MS = 8000
const DISCOVERY_TTL_MS = 10 * 60_000

type DiscoveryEntry = { value: MailDiscovery | null; expires: number }
const discoveryCache = new Map<string, DiscoveryEntry>()
const discoveryInFlight = new Map<string, Promise<MailDiscovery | null>>()

/** Clear the discovery cache (tests, and account switches that change domain). */
export function clearMailDiscoveryCache(): void {
  discoveryCache.clear()
  discoveryInFlight.clear()
}

/** The well-known mail-discovery document for `domain`. */
export function mailDiscoveryUrl(domain: string): string {
  return `https://${domain}/.well-known/nostr-mail.json`
}

/**
 * Where to look for the discovery document, in order.
 *
 * The contract is the well-known `/.well-known/nostr-mail.json` on the mail
 * domain (nginx proxies it to the backend's `/api/mails/discovery`). Until
 * that proxy is wired on a deployment, the identical document is served
 * directly by the backend, so it is the fallback — the feature must not depend
 * on a deploy step landing first.
 */
function discoveryCandidates(domain: string): string[] {
  const wellKnown = mailDiscoveryUrl(domain)
  const backend = apiUrl('/api/mails/discovery')
  // In dev `apiUrl` returns a relative path the Vite proxy forwards; in prod it
  // is absolute. Either way it is a distinct candidate from the well-known.
  return wellKnown === backend ? [wellKnown] : [wellKnown, backend]
}

/**
 * Validate the discovery document. Anything missing or mistyped makes the
 * whole document unusable: we cannot POST a wrap without a bridge pubkey AND
 * an endpoint, so a partial answer is a hard miss (caller falls back to relay).
 */
function parseDiscovery(body: unknown): MailDiscovery | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  if (typeof o.bridge_pubkey !== 'string' || !o.bridge_pubkey) return null
  if (typeof o.send_wrap_endpoint !== 'string' || !o.send_wrap_endpoint) return null
  return { bridgePubkey: o.bridge_pubkey, sendWrapEndpoint: o.send_wrap_endpoint }
}

/**
 * Fetch (and cache) the mail-discovery document for `domain`. Bounded and
 * fail-open-to-relay: any error, timeout, 404, or malformed body resolves to
 * `null`, and the caller then publishes over Nostr as before.
 */
export async function fetchMailDiscovery(
  domain: string,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<MailDiscovery | null> {
  const cached = discoveryCache.get(domain)
  if (cached && cached.expires > Date.now()) return cached.value

  const pending = discoveryInFlight.get(domain)
  if (pending) return pending

  const query = (async (): Promise<MailDiscovery | null> => {
    for (const url of discoveryCandidates(domain)) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) continue
        const parsed = parseDiscovery(await res.json())
        if (parsed) return parsed
      } catch {
        // Try the next candidate.
      }
    }
    return null
  })()
    .then((value) => {
      // Cache positives for the session; negatives only briefly, so a backend
      // that is mid-deploy or briefly down retries rather than sticking.
      discoveryCache.set(domain, {
        value,
        expires: Date.now() + (value ? DISCOVERY_TTL_MS : 60_000),
      })
      return value
    })
    .finally(() => discoveryInFlight.delete(domain))

  discoveryInFlight.set(domain, query)
  return query
}

/**
 * Ask the backend to relay a client-sealed gift wrap through the bridge.
 *
 * The wrap must already be addressed (p-tagged) to `discovery.bridgePubkey`;
 * the backend shape-checks it and the bridge authorizes the From from the seal
 * inside — we never decrypt or inspect it here. NIP-98 proves a real client
 * made the request. Never throws; every failure is a `SendWrapResult` so the
 * caller can fall back to relay publish.
 */
export async function sendWrapViaApi(params: {
  wrap: unknown
  discovery: MailDiscovery
  signer: Nip98Signer
}): Promise<SendWrapResult> {
  const path = safePath(params.discovery.sendWrapEndpoint)
  if (!path) return { ok: false, status: 0, reason: 'invalid send-wrap endpoint' }

  const body = JSON.stringify({ wrap: params.wrap })
  let authHeader: string
  try {
    // Sign the canonical URL (what the backend sees behind the dev proxy) and
    // include the body so its payload-hash check passes.
    authHeader = await buildNip98Header(params.signer, apiAuthUrl(path), 'POST', body)
  } catch (e) {
    return { ok: false, status: 0, reason: (e as Error).message }
  }

  try {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    if (res.ok) return { ok: true, status: res.status }
    const detail = await res.text().catch(() => '')
    return { ok: false, status: res.status, reason: detail || res.statusText }
  } catch (e) {
    return { ok: false, status: 0, reason: (e as Error).message }
  }
}

/** Path (+query) of an endpoint, or null when it isn't a valid absolute URL. */
function safePath(endpoint: string): string | null {
  try {
    const url = new URL(endpoint)
    return `${url.pathname}${url.search}`
  } catch {
    return null
  }
}
