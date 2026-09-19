import type { PgpKeypair } from '@/app/lib/nostr/settings'
import { generateKeySet } from './openpgp'
import { ownPublicKeysFor } from './keyring'

/**
 * Rotate one alias's PGP key set: generate a fresh dual pair, persist it, then
 * publish the new public halves to WKD.
 *
 * Ordering is deliberate and load-bearing:
 *
 *  1. **Generate** — a failure here changes nothing anywhere.
 *  2. **Persist** (the caller-supplied `save`) — a failure aborts BEFORE any
 *     publish, so WKD never advertises a key the user cannot decrypt with.
 *     Without this ordering, a failed settings save would leave the new public
 *     key discoverable while the private half was never stored: the user would
 *     keep nothing they can open old or new mail with.
 *  3. **Publish** (the caller-supplied `publish`) — WKD overwrite is verified
 *     to replace the previous key (PUT /api/wkd updates the nip05 row in place;
 *     see docs/Session-Log.md, 2026-09-19), so no unpublish step is needed.
 *     A failure here does NOT roll back the rotation: the new key is already
 *     saved and is the correct key to use — it is reported so the UI can offer
 *     a republish (the existing Republish-to-WKD action retries exactly this).
 *
 * Nothing here imports a store or a component, keeping it unit-testable with
 * plain functions (AGENTS rule 6: services compute).
 */
export interface RotateKeyResult {
  keypair: PgpKeypair
  /** True when the new key reached WKD; false means the caller should surface a republish hint. */
  published: boolean
  /** Why the publish failed, when it did. The rotation itself still succeeded. */
  publishError?: string
}

export async function rotateAliasKey(params: {
  address: string
  /** Persist the new keypair (settings store `save`). Must throw on failure. */
  save: (keypair: PgpKeypair) => Promise<void>
  /** Publish the new public halves to WKD. Failures are reported, not fatal. */
  publish: (address: string, publicKeys: string[]) => Promise<void>
}): Promise<RotateKeyResult> {
  const { address, save, publish } = params

  const gen = await generateKeySet({ email: address })
  const keypair: PgpKeypair = {
    publicKey: gen.v4.publicKey,
    privateKey: gen.v4.privateKey,
    fingerprint: gen.v4.fingerprint,
    passphraseProtected: false,
    v4: { publicKey: gen.v4.publicKey, privateKey: gen.v4.privateKey, fingerprint: gen.v4.fingerprint },
    v6: { publicKey: gen.v6.publicKey, privateKey: gen.v6.privateKey, fingerprint: gen.v6.fingerprint },
  }

  await save(keypair)

  try {
    await publish(address, ownPublicKeysFor(keypair))
    return { keypair, published: true }
  } catch (e) {
    return {
      keypair,
      published: false,
      publishError: e instanceof Error ? e.message : String(e),
    }
  }
}
