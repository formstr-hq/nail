import type { MailSettings } from '@/lib/nostr/settings'
import { readKeyInfo, validatePublicKey } from './openpgp'

/**
 * The correspondent keyring: which of the people you write to you hold a PGP
 * public key for. It lives in the encrypted settings blob (`pgpKeyring`), keyed
 * by lowercased email address — public keys only, so it is safe to sync.
 *
 * These are pure helpers over that map plus the settings' own key. The UI and
 * the compose/read paths go through here rather than touching the map directly,
 * so address normalization (lowercasing, matching how the rest of the mailbox
 * compares addresses) happens in exactly one place.
 */

/** Normalize an address to its keyring key. Matches the app's alias matching. */
export function keyringKey(address: string): string {
  return address.trim().toLowerCase()
}

/** The armored public key held for an address, or undefined. */
export function keyForAddress(
  settings: Pick<MailSettings, 'pgpKeyring' | 'pgpPublicKey'> & { ownAddresses?: string[] },
  address: string,
): string | undefined {
  const key = keyringKey(address)
  // The user's own address resolves to their own public key, so encrypting to
  // yourself (the Sent-copy path) never needs a manual keyring entry.
  if (settings.ownAddresses?.some((a) => keyringKey(a) === key) && settings.pgpPublicKey) {
    return settings.pgpPublicKey
  }
  return settings.pgpKeyring?.[key]
}

/** True when every address has a public key we can encrypt to. */
export function haveKeysForAll(
  settings: Pick<MailSettings, 'pgpKeyring' | 'pgpPublicKey'> & { ownAddresses?: string[] },
  addresses: string[],
): boolean {
  return addresses.length > 0 && addresses.every((a) => !!keyForAddress(settings, a))
}

/** Addresses from the list we do NOT hold a key for — what the UI names. */
export function addressesMissingKeys(
  settings: Pick<MailSettings, 'pgpKeyring' | 'pgpPublicKey'> & { ownAddresses?: string[] },
  addresses: string[],
): string[] {
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
