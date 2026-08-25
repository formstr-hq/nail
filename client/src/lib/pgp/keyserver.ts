import { validatePublicKey } from './openpgp'

/**
 * Discovery and publication against a VKS keyserver (keys.openpgp.org by
 * default) — the "shared registry" that lets mailstr interoperate with the
 * outside PGP world without manual key exchange.
 *
 * Why this one: keys.openpgp.org is the modern, maintained keyserver and, unlike
 * the old SKS network, it VERIFIES email ownership before serving a key by
 * address. So a by-email hit means "someone who controls that mailbox published
 * this key" — a real, if modest, binding, and exactly the signal the composer
 * wants: a key came back ⇒ this recipient uses PGP ⇒ encrypt to them.
 *
 * It serves `Access-Control-Allow-Origin: *`, so the browser calls it directly;
 * no bridge or proxy involved. Only PUBLIC keys ever cross this boundary.
 *
 * The publish side is two steps by design: an upload makes a key retrievable by
 * FINGERPRINT immediately, but retrievable by EMAIL only after the address owner
 * clicks a verification link the keyserver emails them. We do both — upload then
 * request-verify — so generating a key also starts making the user discoverable.
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

/** The keyserver's reply to an upload / verification request. */
export interface UploadResult {
  keyFingerprint: string
  /** Opaque token, needed to request email verification for this upload. */
  token: string
  /** Per-address publication state: unpublished | published | pending | revoked. */
  status: Record<string, string>
}

/**
 * Upload an armored public key. Makes it retrievable by fingerprint at once;
 * addresses come back `unpublished` until verified (see requestVerify).
 */
export async function uploadKey(armoredPublicKey: string): Promise<UploadResult> {
  const res = await fetch(`${baseUrl()}/vks/v1/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keytext: armoredPublicKey }),
  })
  if (!res.ok) throw new Error(`Keyserver upload failed (${res.status})`)
  const json = (await res.json()) as { key_fpr: string; token: string; status: Record<string, string> }
  return { keyFingerprint: json.key_fpr, token: json.token, status: json.status }
}

/**
 * Ask the keyserver to email verification links for the given addresses, so the
 * key becomes discoverable BY EMAIL once the owner confirms. `token` comes from
 * the preceding upload.
 */
export async function requestVerify(token: string, addresses: string[]): Promise<UploadResult> {
  const res = await fetch(`${baseUrl()}/vks/v1/request-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, addresses }),
  })
  if (!res.ok) throw new Error(`Keyserver verification request failed (${res.status})`)
  const json = (await res.json()) as { key_fpr: string; token: string; status: Record<string, string> }
  return { keyFingerprint: json.key_fpr, token: json.token, status: json.status }
}

/**
 * Publish a freshly generated key: upload it, then request email verification
 * for its addresses so it becomes discoverable by email (not just fingerprint).
 *
 * Best-effort by contract — the caller treats a rejection as "not published
 * yet", never as a reason to fail key generation. The verification email lands
 * in the user's own mailbox (for a mailstr address, through the bridge), where
 * one click finishes the job.
 */
export async function publishKey(
  armoredPublicKey: string,
  addresses: string[],
): Promise<UploadResult> {
  const uploaded = await uploadKey(armoredPublicKey)
  if (addresses.length === 0) return uploaded
  return requestVerify(uploaded.token, addresses)
}
