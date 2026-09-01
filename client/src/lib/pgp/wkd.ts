import { validatePublicKey } from './openpgp'

/**
 * Web Key Directory (WKD) lookup — fetching a correspondent's public key from
 * THEIR OWN mail domain.
 *
 * This is the discovery mechanism the serious PGP providers (Proton, Mailbox,
 * Posteo) actually use, and it's more authoritative than a keyserver: the key is
 * served by the domain that runs the mailbox, so "the domain vouches for its own
 * user" rather than "someone verified an email once". We try it first, and fall
 * back to a keyserver for domains that don't publish WKD.
 *
 * WKD defines two URL layouts for `local-part@domain`:
 *   advanced: https://openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<hash>?l=<lp>
 *   direct:   https://<domain>/.well-known/openpgpkey/hu/<hash>?l=<lp>
 * where <hash> is zbase32(sha1(lowercased local-part)). We try advanced then
 * direct, matching the spec's preference order.
 *
 * Browser reachability: this is a cross-origin fetch to an arbitrary domain, so
 * it only succeeds where that host sends permissive CORS (verified: Proton does,
 * reflecting the request Origin). A CORS-blocked or absent endpoint simply
 * yields `null` — never an error, never a block on sending — and the caller
 * moves on to the keyserver.
 */

const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'

/** zbase32-encode bytes, per the WKD spec's hash encoding. */
function zbase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ZBASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ZBASE32[(value << (5 - bits)) & 31]
  return out
}

/** The WKD hash of a local-part: zbase32(sha1(lowercased local-part)). */
async function wkdHash(localPart: string): Promise<string> {
  const data = new TextEncoder().encode(localPart.toLowerCase())
  const digest = await crypto.subtle.digest('SHA-1', data)
  return zbase32(new Uint8Array(digest))
}

/** The advanced- and direct-method WKD URLs for an address, in preference order. */
export async function wkdUrls(email: string): Promise<string[]> {
  const at = email.lastIndexOf('@')
  if (at <= 0) return []
  const localPart = email.slice(0, at)
  const domain = email.slice(at + 1).toLowerCase()
  const hash = await wkdHash(localPart)
  const lp = encodeURIComponent(localPart)
  return [
    `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}?l=${lp}`,
    `https://${domain}/.well-known/openpgpkey/hu/${hash}?l=${lp}`,
  ]
}

/**
 * Look up an address's public key via WKD. Returns the armored key, or `null`
 * when the domain doesn't publish one, blocks CORS, or the response isn't a
 * valid key — all of which are routine "no key here, try elsewhere" outcomes,
 * never errors.
 *
 * WKD serves the key as BINARY (a raw transferable key, not armored), so the
 * bytes are handed to the OpenPGP layer to re-armor and validate.
 */
export async function lookupByWkd(email: string): Promise<string | null> {
  for (const url of await wkdUrls(email)) {
    let res: Response
    try {
      res = await fetch(url)
    } catch {
      // CORS block, DNS failure, offline — indistinguishable here and all mean
      // "can't get it from this URL". Try the next layout, then give up.
      continue
    }
    if (!res.ok) continue
    try {
      const bytes = new Uint8Array(await res.arrayBuffer())
      const armored = await armorPublicKey(bytes)
      await validatePublicKey(armored)
      return armored
    } catch {
      continue
    }
  }
  return null
}

/** Re-armor a binary (transferable) public key into the armored form we store. */
async function armorPublicKey(binary: Uint8Array): Promise<string> {
  const openpgp = await import('openpgp')
  const key = await openpgp.readKey({ binaryKey: binary })
  return key.toPublic().armor()
}
