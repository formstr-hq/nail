import type { KeyHalf, MailSettings, PgpKeypair } from '@/app/lib/nostr/settings'
import { readKeyInfo, validatePublicKey } from './openpgp'

/**
 * Two key stores, both in the encrypted settings blob:
 *  - `pgpKeys`    — the user's OWN keypairs, one PER ALIAS (see settings.ts for
 *                   why per-alias: binding aliases to one key would link them).
 *  - `pgpKeyring` — correspondents' public keys, keyed by lowercased address.
 *
 * These are pure helpers over those maps. The UI and the compose/read paths go
 * through here rather than touching the maps directly, so address normalization
 * (lowercasing, matching how the rest of the mailbox compares addresses) happens
 * in exactly one place.
 */

/** The settings slice the key helpers need. */
export type KeySettings = Pick<MailSettings, 'pgpKeyring' | 'pgpKeys'>

/** The settings slice the compose/send paths need for encryption decisions. */
export type PgpSettings = KeySettings

/** Normalize an address to its keyring key. Matches the app's alias matching. */
export function keyringKey(address: string): string {
  return address.trim().toLowerCase()
}

/** The user's own keypair for one of their alias addresses, if they have one. */
export function ownKeypairFor(settings: KeySettings, address: string): PgpKeypair | undefined {
  return settings.pgpKeys?.[keyringKey(address)]
}

/**
 * Every encryption-capable PUBLIC key for one of the user's own aliases. With
 * the dual set both halves are returned (mail is encrypted to both so either
 * key can decrypt); a legacy single-pair entry contributes its top-level key.
 */
export function ownPublicKeysFor(keypair: PgpKeypair): string[] {
  const halves = [keypair.v4, keypair.v6].filter((h): h is KeyHalf => !!h)
  if (halves.length) return halves.map((h) => h.publicKey)
  return [keypair.publicKey]
}

/**
 * A decryption half: a dual `KeyHalf` plus the keypair-level lock flag.
 *
 * `keypairFingerprint` is the KEYPAIR's own fingerprint — the same value on
 * every half of one alias, dual set or not. One passphrase locks the whole
 * set (see below), so anything that caches or looks up that passphrase
 * (session.ts) MUST key off `keypairFingerprint`, never off `fingerprint` —
 * the half's own fingerprint differs between v4 and v6, which would otherwise
 * make unlocking one half never unlock the other.
 */
export type DecryptionHalf = KeyHalf & { passphraseProtected?: boolean; keypairFingerprint: string }

/**
 * Every DECRYPTION-capable private key half for an alias (dual-aware).
 *
 * `passphraseProtected` is stored at the KEYPAIR level (one passphrase guards
 * the whole set), but `KeyHalf` doesn't carry it — so it is stamped onto every
 * half here. Without this, a dual set's halves look unlocked and the read path
 * feeds a passphrase-encrypted private key straight to openpgp, which fails;
 * the passphrase prompt never fires because the viewer never learns the key is
 * locked.
 */
export function ownPrivateKeysFor(keypair: PgpKeypair): DecryptionHalf[] {
  const halves = [keypair.v4, keypair.v6].filter((h): h is KeyHalf => !!h)
  if (halves.length) {
    return halves.map((h) => ({
      ...h,
      passphraseProtected: keypair.passphraseProtected,
      keypairFingerprint: keypair.fingerprint,
    }))
  }
  return [
    {
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      fingerprint: keypair.fingerprint,
      passphraseProtected: keypair.passphraseProtected,
      keypairFingerprint: keypair.fingerprint,
    },
  ]
}

/** Every own keypair the user holds, across all their aliases. */
export function allOwnKeypairs(settings: KeySettings): PgpKeypair[] {
  return Object.values(settings.pgpKeys ?? {})
}

/** True when the user has at least one alias key (so encryption is possible). */
export function hasAnyOwnKey(settings: KeySettings): boolean {
  return allOwnKeypairs(settings).length > 0
}

/**
 * The armored PUBLIC key to encrypt to for an address, or undefined.
 *
 * An address that is one of the user's OWN aliases resolves to that alias's own
 * public key — so encrypting to yourself (the Sent-copy path) needs no keyring
 * entry. Everyone else comes from the correspondent keyring.
 */
export function keyForAddress(settings: KeySettings, address: string): string | undefined {
  const own = ownKeypairFor(settings, address)
  if (own) return ownPublicKeysFor(own)[0]
  return settings.pgpKeyring?.[keyringKey(address)]
}

/**
 * EVERY public key to encrypt to for an address: for a dual-set alias both
 * halves, for everyone else the keyring entry. Outbound encryption passes the
 * whole list so either key version can decrypt.
 */
export function allKeysForAddress(settings: KeySettings, address: string): string[] {
  const own = ownKeypairFor(settings, address)
  if (own) return ownPublicKeysFor(own)
  const ringed = settings.pgpKeyring?.[keyringKey(address)]
  return ringed ? [ringed] : []
}

/** True when every address has a public key we can encrypt to. */
export function haveKeysForAll(settings: KeySettings, addresses: string[]): boolean {
  return addresses.length > 0 && addresses.every((a) => !!keyForAddress(settings, a))
}

/** Addresses from the list we do NOT hold a key for — what the UI names. */
export function addressesMissingKeys(settings: KeySettings, addresses: string[]): string[] {
  return addresses.filter((a) => !keyForAddress(settings, a))
}

/**
 * Add a correspondent's armored public key (or keys — a WKD multi-key blob
 * yields several) to the keyring, returning the new keyring map. Validates each
 * key and files them under every email address the key claims (a PGP key may
 * carry several user IDs) plus, if given, the address the user is importing it
 * for. Multiple keys for the same address are stored CONCATENATED in armored
 * form — the ring entry stays a single string, and encryption hands every
 * embedded key to openpgp.
 *
 * Throws if the armored input is not a valid public key.
 */
export async function addToKeyring(
  keyring: Record<string, string> | undefined,
  armoredPublicKey: string | string[],
  forAddress?: string,
): Promise<Record<string, string>> {
  const armoreds = Array.isArray(armoredPublicKey) ? armoredPublicKey : [armoredPublicKey]
  if (!armoreds.length) throw new Error('No keys to add.')
  const infos = await Promise.all(armoreds.map((a) => validatePublicKey(a)))

  const next = { ...(keyring ?? {}) }
  const addresses = new Set<string>()
  for (const info of infos) for (const email of info.emails) addresses.add(keyringKey(email))
  if (forAddress) addresses.add(keyringKey(forAddress))
  if (addresses.size === 0) {
    throw new Error('This key carries no email address; import it for a specific address.')
  }

  // One entry per address: existing keys are kept and the new ones appended,
  // armored blocks joined by a blank line — a form openpgp.readKeys parses.
  // Each block is trimmed to its armor boundary so entries stay canonical.
  for (const address of addresses) {
    const existing = keysInEntry(next[address])
    const merged = [...new Set([...existing, ...armoreds])]
    next[address] = merged.join('\n')
  }
  return next
}

/** Remove an address's entry, returning the new keyring map. */
export function removeFromKeyring(
  keyring: Record<string, string> | undefined,
  address: string,
): Record<string, string> {
  const next = { ...(keyring ?? {}) }
  delete next[keyringKey(address)]
  return next
}

/** One correspondent, for listing the keyring in the UI. */
export interface KeyringEntry {
  address: string
  fingerprint: string
  userIDs: string[]
  /** How many keys the entry holds (dual sets hold two). */
  count: number
}

/**
 * Split a keyring entry into its individual armored blocks — entries hold one
 * or more keys (multi-key WKD merges) joined by armor boundaries.
 */
function splitArmoreds(entry: string): string[] {
  const marker = /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/g
  const found = entry.match(marker)
  return (found ?? [entry]).map((block) => block.trimEnd())
}

/** Decode every keyring entry for display, skipping any that no longer parse. */
export async function keyringEntries(
  keyring: Record<string, string> | undefined,
): Promise<KeyringEntry[]> {
  const out: KeyringEntry[] = []
  for (const [address, armored] of Object.entries(keyring ?? {})) {
    try {
      const armoreds = splitArmoreds(armored)
      const infos = await Promise.all(armoreds.map((a) => readKeyInfo(a)))
      out.push({
        address,
        fingerprint: infos[0].fingerprint,
        userIDs: [...new Set(infos.flatMap((i) => i.userIDs))],
        count: armoreds.length,
      })
    } catch {
      // A corrupt or unreadable entry is skipped rather than crashing the list.
    }
  }
  return out.sort((a, b) => a.address.localeCompare(b.address))
}

/**
 * EVERY armored public key an entry holds, split back out — what the encrypt
 * path hands to openpgp. A single-key entry yields a one-element array.
 */
export function keysInEntry(entry: string | undefined): string[] {
  if (!entry) return []
  return splitArmoreds(entry)
}
