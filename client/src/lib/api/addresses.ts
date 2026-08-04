import type { ActiveSigner } from '@formstr/signer'
import { withSignerTimeout } from '../nostr/signer'
import { BRIDGE_DOMAIN } from '../nostr/constants'
import { apiUrl, apiAuthUrl } from './config'
import { buildNip98Header, type Nip98Signer } from './nip98'

/**
 * Thrown when the backend rejects the NIP-98 auth header (401) — the
 * session needs re-establishing. Kept distinct from a generic `Error` so
 * callers can special-case "sign in again" with `instanceof` rather than
 * string-matching a message.
 */
export class Nip98AuthError extends Error {
  constructor(message = 'Not authorized — sign in again') {
    super(message)
    this.name = 'Nip98AuthError'
  }
}

/**
 * Normalize the get-nip05 response body into a flat list of nip05
 * addresses. The exact response shape hasn't been confirmed against
 * production (hence the console.debug in fetchOwnedAddresses below), so
 * this tolerates every plausible shape rather than assuming one. Anything
 * unrecognized is treated as "no addresses" — this never throws.
 *
 * Handles:
 *   - a bare string
 *   - string[]
 *   - { nip05: string }
 *   - { nip05Addresses: string[] }
 *   - an array of objects each with a `nip05` or `name` field
 *
 * A NIP-05 record's `name` is only the localpart (`abhay`), so any entry
 * without an `@` is qualified with BRIDGE_DOMAIN before it leaves here.
 * Every downstream consumer — the Settings sender picker, and the
 * `senderOwnsFromAddress` check in send.ts, which calls `splitAddress` and
 * needs a domain — depends on getting a full `localpart@domain` address; a
 * bare name silently fails the ownership guard at send time.
 *
 * Kept separate from the fetch logic so it's a plain, pure function —
 * straightforward to unit test in isolation if/when this repo grows a test
 * runner (see report: none exists in client/ today).
 */
export function normalizeOwnedAddresses(body: unknown): string[] {
  const qualify = (addr: string): string =>
    addr.includes('@') ? addr : `${addr}@${BRIDGE_DOMAIN}`

  if (typeof body === 'string') return [qualify(body)]

  let raw: string[] = []

  if (Array.isArray(body)) {
    raw = body.flatMap((entry): string[] => {
      if (typeof entry === 'string') return [entry]
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>
        if (typeof obj.nip05 === 'string') return [obj.nip05]
        if (typeof obj.name === 'string') return [obj.name]
      }
      return []
    })
  } else if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    if (typeof obj.nip05 === 'string') raw = [obj.nip05]
    else if (Array.isArray(obj.nip05Addresses)) {
      raw = obj.nip05Addresses.filter((v): v is string => typeof v === 'string')
    }
  }

  return raw.map(qualify)
}

/**
 * Ask the backend which mailstr.app nip05 addresses the signed-in npub
 * owns. NIP-98 authenticated (see nip98.ts) — the signer call is bounded
 * by withSignerTimeout per this codebase's signer invariant (unresponsive
 * NIP-46 bunkers otherwise hang forever).
 */
export async function fetchOwnedAddresses(active: ActiveSigner): Promise<string[]> {
  const path = '/api/nip-05/get-nip05'

  const boundSigner: Nip98Signer = {
    signEvent: (event) => withSignerTimeout('signEvent', () => active.signEvent(event)),
  }
  // Sign the canonical URL, not the one we fetch: behind the dev proxy those
  // differ, and NIP-98's `u` tag must match what the server receives.
  const authHeader = await buildNip98Header(boundSigner, apiAuthUrl(path), 'GET')

  const url = apiUrl(path)

  const res = await fetch(url, { headers: { Authorization: authHeader } })

  if (res.status === 404) return []

  if (res.status === 401) {
    throw new Nip98AuthError()
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const err = (await res.json()) as { error?: string }
      if (err.error) message = err.error
    } catch {
      // keep the status-based message
    }
    throw new Error(message)
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // empty or non-JSON success body — treat as "no addresses"
  }
  // Deliberately unconditional (not gated behind a dev-only flag) so the
  // real response shape can be confirmed against production without a
  // redeploy.
  console.debug('[addresses] get-nip05 response', body)

  return normalizeOwnedAddresses(body)
}
