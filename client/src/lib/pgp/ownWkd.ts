import type { ActiveSigner } from '@formstr/signer'
import { withSignerTimeout } from '../nostr/signer'
import { apiUrl, apiAuthUrl } from '../api/config'
import { buildNip98Header, type Nip98Signer } from '../api/nip98'

/**
 * Publish one of our own PGP public keys to our backend's WKD directory, so the
 * outside PGP world can discover it off `mailstr.app/.well-known/openpgpkey/...`
 * and encrypt to us.
 *
 * This is the authoritative publish path for our OWN addresses — stronger than a
 * keyserver (no email round-trip; the backend already vouches for the identity
 * via NIP-05) — so it runs alongside the keys.openpgp.org publish, not instead.
 *
 * The backend serves WKD as BINARY, so we send the binary transferable key,
 * base64-encoded for JSON. NIP-98 authed; the backend checks the signing key
 * actually owns the address.
 */
export async function publishToOwnWkd(params: {
  address: string
  /** Armored public key — we derive the binary form here. */
  armoredPublicKey: string
  active: ActiveSigner
}): Promise<void> {
  const publicKeyB64 = await armoredToBinaryB64(params.armoredPublicKey)

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

/** Base64 of the binary (transferable) public key — the form WKD serves. */
async function armoredToBinaryB64(armored: string): Promise<string> {
  const openpgp = await import('openpgp')
  const key = await openpgp.readKey({ armoredKey: armored })
  const bytes = key.toPublic().write()
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
