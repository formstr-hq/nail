import type { PgpKeypair } from '@/app/lib/nostr/settings'
import type { GeneratedKeySet } from './openpgp'
import { ownPublicKeysFor } from './keyring'

/**
 * Installing an alias key — the ONE place a keypair goes from "generated in
 * memory" to "stored and published". First-time generation and rotation both
 * go through here; they differ only in whether there is a previous keypair to
 * restore.
 *
 * Order and failure handling are deliberate:
 *
 *  1. **Save first.** The settings blob is the only place the private half
 *     exists, so committing it first means we never publish a public key we
 *     cannot decrypt with. The reverse order — publish, then save — has the
 *     worse failure mode: a save failure after a successful publish leaves WKD
 *     advertising a key whose private half was lost, and inbound mail encrypted
 *     to it becomes unreadable. Saving first cannot lose mail.
 *  2. **Then publish, atomically.** A publish failure means the install did not
 *     happen: the save is rolled back (restore `previous`, or remove the entry
 *     when there was none — safe precisely because the publish failed, so WKD
 *     never saw the key). The end state matches "if WKD fails, don't keep the
 *     key" without ever leaving an orphaned WKD publish behind.
 *  3. **If the rollback itself fails**, the new key stays stored but
 *     unpublished and the caller is told (`saved: true`) so it can point at
 *     Republish, which retries the publish for the key actually stored.
 *
 * Nothing here imports a store or a component (AGENTS rule 6: services compute).
 */
export type InstallResult =
  | { status: 'installed' }
  | { status: 'failed'; error: string; saved: boolean }

/** Build the settings-shaped keypair from a freshly generated dual set. */
export function keypairFromSet(set: GeneratedKeySet): PgpKeypair {
  return {
    publicKey: set.v4.publicKey,
    privateKey: set.v4.privateKey,
    fingerprint: set.v4.fingerprint,
    passphraseProtected: false,
    v4: { ...set.v4 },
    v6: { ...set.v6 },
  }
}

export async function installAliasKey(params: {
  address: string
  keypair: PgpKeypair
  /** The keypair to restore if the publish fails; absent when the alias had none. */
  previous?: PgpKeypair
  /** Persist (or, with `null`, remove — the rollback path) the alias keypair. Must throw on failure. */
  save: (keypair: PgpKeypair | null) => Promise<void>
  /** Publish the public halves to WKD. Must throw on failure. */
  publish: (address: string, publicKeys: string[]) => Promise<void>
}): Promise<InstallResult> {
  const { address, keypair, previous, save, publish } = params
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  try {
    await save(keypair)
  } catch (e) {
    return { status: 'failed', error: message(e), saved: false }
  }

  try {
    await publish(address, ownPublicKeysFor(keypair))
    return { status: 'installed' }
  } catch (e) {
    const error = message(e)
    try {
      await save(previous ?? null)
      return { status: 'failed', error, saved: false }
    } catch (rollbackError) {
      return {
        status: 'failed',
        error: `${error} — and restoring the previous state failed: ${message(rollbackError)}`,
        saved: true,
      }
    }
  }
}
