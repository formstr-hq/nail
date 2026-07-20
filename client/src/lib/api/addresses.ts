import type { ActiveSigner } from '@formstr/signer'
import { withSignerTimeout } from '../nostr/signer'
import { apiUrl } from './config'
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
 * Kept separate from the fetch logic so it's a plain, pure function —
 * straightforward to unit test in isolation if/when this repo grows a test
 * runner (see report: none exists in client/ today).
 */
export function normalizeOwnedAddresses(body: unknown): string[] {
  if (typeof body === 'string') return [body]

  if (Array.isArray(body)) {
    return body.flatMap((entry): string[] => {
      if (typeof entry === 'string') return [entry]
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>
        if (typeof obj.nip05 === 'string') return [obj.nip05]
        if (typeof obj.name === 'string') return [obj.name]
      }
      return []
    })
  }

  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    if (typeof obj.nip05 === 'string') return [obj.nip05]
    if (Array.isArray(obj.nip05Addresses)) {
      return obj.nip05Addresses.filter((v): v is string => typeof v === 'string')
    }
  }

  return []
}

/**
 * Ask the backend which mailstr.app nip05 addresses the signed-in npub
 * owns. NIP-98 authenticated (see nip98.ts) — the signer call is bounded
 * by withSignerTimeout per this codebase's signer invariant (unresponsive
 * NIP-46 bunkers otherwise hang forever).
 */
export async function fetchOwnedAddresses(active: ActiveSigner): Promise<string[]> {
  const url = apiUrl('/api/nip-05/get-nip05')

  const boundSigner: Nip98Signer = {
    signEvent: (event) => withSignerTimeout('signEvent', () => active.signEvent(event)),
  }
  const authHeader = await buildNip98Header(boundSigner, url, 'GET')

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

  const body = await res.json()
  // Deliberately unconditional (not gated behind a dev-only flag) so the
  // real response shape can be confirmed against production without a
  // redeploy.
  console.debug('[addresses] get-nip05 response', body)

  return normalizeOwnedAddresses(body)
}
