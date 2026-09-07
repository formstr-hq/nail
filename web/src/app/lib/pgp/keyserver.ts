import { validatePublicKey } from './openpgp'

/**
 * Keyserver LOOKUP against a VKS keyserver (keys.openpgp.org by default) — a
 * discovery fallback that lets mailstr find a correspondent's key when WKD
 * doesn't have it, without manual key exchange.
 *
 * Why this one: keys.openpgp.org is the modern, maintained keyserver and, unlike
 * the old SKS network, it VERIFIES email ownership before serving a key by
 * address. So a by-email hit means "someone who controls that mailbox published
 * this key" — a real, if modest, binding, and exactly the signal the composer
 * wants: a key came back ⇒ this recipient uses PGP ⇒ encrypt to them.
 *
 * It serves `Access-Control-Allow-Origin: *`, so the browser calls it directly;
 * no bridge or proxy involved.
 *
 * We deliberately do NOT publish here — our own keys go to our WKD directory
 * (lib/pgp/ownWkd.ts), which is authoritative and needs no email verification.
 * Publishing to a third-party keyserver would add a verification step and
 * permanently register the address↔key link off-domain. This module is
 * lookup-only; a hit here just means the correspondent chose to publish there.
 */

const DEFAULT_KEYSERVER = 'https://keys.openpgp.org'

function baseUrl(): string {
  return import.meta.env.VITE_PGP_KEYSERVER || DEFAULT_KEYSERVER
}

/**
 * Look up a published public key by email address. Returns the armored key, or
 * `null` when the keyserver has no verified key for that address (a 404 — the
 * common, routine case, not an error).
 *
 * A returned key is validated before it's handed back, so a malformed or
 * hostile response can't reach the keyring.
 */
export async function lookupByEmail(email: string): Promise<string | null> {
  const url = `${baseUrl()}/vks/v1/by-email/${encodeURIComponent(email.trim().toLowerCase())}`
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/pgp-keys' } })
  } catch {
    // Network/keyserver down — indistinguishable from "no key" for our purposes,
    // and never a reason to block sending. Treat as not-found.
    return null
  }
  if (res.status === 404) return null
  if (!res.ok) return null // 429 rate-limit, 5xx, etc. — degrade to not-found
  const armored = await res.text()
  try {
    await validatePublicKey(armored)
    return armored
  } catch {
    return null
  }
}
