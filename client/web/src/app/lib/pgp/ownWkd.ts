import type { ActiveSigner } from '@formstr/signer'
import { withSignerTimeout } from '../nostr/signer'
import { apiUrl, apiAuthUrl } from '@/app/lib/api/config'
import { buildNip98Header, type Nip98Signer } from '@/lib/nip98'

/**
 * Publish one of our own PGP public keys to our backend's WKD directory, so the
 * outside PGP world can discover it off `mailstr.app/.well-known/openpgpkey/...`
 * and encrypt to us.
 *
 * With the DUAL set both public halves (v4 + v6) are published together as ONE
 * binary blob — WKD's standard multi-key form: a concatenation of transferable
 * public keys, which conforming clients iterate over and pick whatever version
 * they support. Mail services that can't read v6 take the v4 half; modern
 * clients can take either.
 *
 * This is the authoritative publish path for our OWN addresses — stronger than a
 * keyserver (no email round-trip; the backend already vouches for the identity
 * via NIP-05).
 *
 * The backend serves WKD as BINARY, so we send the binary transferable keys,
 * base64-encoded for JSON. NIP-98 authed; the backend checks the signing key
 * actually owns the address.
 */
export async function publishToOwnWkd(params: {
  address: string
  /** Armored public key(s) — we derive the binary form here. One or more keys
   *  are concatenated into the single binary blob WKD serves. */
  armoredPublicKeys: string[] | string
  active: ActiveSigner
}): Promise<void> {
  const armoreds = Array.isArray(params.armoredPublicKeys)
    ? params.armoredPublicKeys
    : [params.armoredPublicKeys]
  if (!armoreds.length) throw new Error('No public key to publish.')
  const publicKeyB64 = await armoredsToBinaryB64(armoreds)

  const path = '/api/wkd'
  const body = JSON.stringify({ address: params.address, publicKeyB64 })

  const boundSigner: Nip98Signer = {
    signEvent: (event) => withSignerTimeout('signEvent', () => params.active.signEvent(event)),
  }
  // Sign the canonical URL (matches what the server sees behind the dev proxy),
  // and include the body so the backend's payload-hash check passes.
  const authHeader = await buildNip98Header(boundSigner, apiAuthUrl(path), 'PUT', body)

  const res = await fetch(apiUrl(path), {
    method: 'PUT',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body,
  })
  if (!res.ok) {
    let message = `WKD publish failed (${res.status})`
    try {
      const err = (await res.json()) as { error?: string }
      if (err.error) message = err.error
    } catch {
      // keep the status-based message
    }
    throw new Error(message)
  }
}

/** Base64 of the concatenated binary transferable public keys — the WKD form. */
async function armoredsToBinaryB64(armoreds: string[]): Promise<string> {
  const openpgp = await import('openpgp')
  const parts: Uint8Array[] = []
  for (const armored of armoreds) {
    const key = await openpgp.readKey({ armoredKey: armored })
    parts.push(key.toPublic().write())
  }
  const bytes = parts.reduce((acc, part) => {
    const out = new Uint8Array(acc.length + part.length)
    out.set(acc)
    out.set(part, acc.length)
    return out
  }, new Uint8Array(0))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
