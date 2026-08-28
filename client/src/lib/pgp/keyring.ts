import type { MailSettings, PgpKeypair } from '@/lib/nostr/settings'
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
type KeySettings = Pick<MailSettings, 'pgpKeyring' | 'pgpKeys'>

/** Normalize an address to its keyring key. Matches the app's alias matching. */
export function keyringKey(address: string): string {
  return address.trim().toLowerCase()
}

/** The user's own keypair for one of their alias addresses, if they have one. */
export function ownKeypairFor(settings: KeySettings, address: string): PgpKeypair | undefined {
  return settings.pgpKeys?.[keyringKey(address)]
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
  return ownKeypairFor(settings, address)?.publicKey ?? settings.pgpKeyring?.[keyringKey(address)]
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
 * Add a correspondent's armored public key to the keyring, returning the new
 * keyring map. Validates the key and files it under every email address the key
 * claims (a PGP key may carry several user IDs) plus, if given, the address the
 * user is importing it for — so a key whose user ID doesn't exactly match the
 * mail address is still usable.
 *
 * Throws if the armored input is not a valid public key.
 */
export async function addToKeyring(
  keyring: Record<string, string> | undefined,
  armoredPublicKey: string,
  forAddress?: string,
): Promise<Record<string, string>> {
  const info = await validatePublicKey(armoredPublicKey)
  const next = { ...(keyring ?? {}) }
  const addresses = new Set(info.emails)
  if (forAddress) addresses.add(keyringKey(forAddress))
  if (addresses.size === 0) {
    throw new Error('This key carries no email address; import it for a specific address.')
  }
  for (const address of addresses) next[keyringKey(address)] = armoredPublicKey
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
}

/** Decode every keyring entry for display, skipping any that no longer parse. */
export async function keyringEntries(
  keyring: Record<string, string> | undefined,
): Promise<KeyringEntry[]> {
  const out: KeyringEntry[] = []
  for (const [address, armored] of Object.entries(keyring ?? {})) {
    try {
      const info = await readKeyInfo(armored)
      out.push({ address, fingerprint: info.fingerprint, userIDs: info.userIDs })
    } catch {
      // A corrupt or unreadable entry is skipped rather than crashing the list.
    }
  }
  return out.sort((a, b) => a.address.localeCompare(b.address))
}
