export {
  // The one signer instance for the whole page (login UI, resume, NIP-55).
  signer as nostrSigner,
  // Shared relay pool for NIP-46 traffic (bunker pairing + silent resume).
  pool,
} from '@/lib/signer'
export { NOSTRCONNECT_RELAYS } from '@/lib/signer'

import { pool } from '@/lib/signer'
import type { ActiveSigner } from '@formstr/signer'
// The tag lives in the shared protocol module so the wire-level unwrap can
// classify a signer throw without importing the web app.
import { SIGNER_ERROR_TAG } from '@protocol'

/** A signer failure (timeout, refusal, transport) — distinguishable from a
 *  decryption failure on the data. See protocol's `isSignerFailure`. */
export class SignerError extends Error {
  readonly tag = SIGNER_ERROR_TAG
}

/** The client code's getter shape: one lazily-shared NIP-46 pool. */
export function getSignerPool() {
  return pool
}

/**
 * Every signer call must be bounded.
 *
 * With a NIP-46 remote signer each encrypt/decrypt/sign is an RPC to the
 * bunker, and nostr-tools' `sendRequest` registers a listener and publishes
 * without any timeout — if the bunker never answers, the promise never
 * settles. Unbounded, that leaves the UI pinned on "Saving…" forever and makes
 * the inbox silently stay empty. A local-key or extension signer resolves far
 * inside this budget, so the ceiling only ever bites when something is wrong.
 *
 * Timeouts throw a tagged `SignerError` so protocol-level unwrap can classify
 * them as `signer-error` (retryable) rather than the routine `not-for-us`.
 *
 * Note this frees the *caller*; the underlying RPC listener is still parked
 * inside the package until the bunker replies or the signer is torn down.
 */
export const SIGNER_TIMEOUT_MS = 20_000

export async function withSignerTimeout<T>(
  label: string,
  op: () => Promise<T>,
  ms: number = SIGNER_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SignerError(
            `Signer did not respond to "${label}" within ${ms / 1000}s. ` +
              `If you signed in with a remote signer, reconnect your bunker and try again.`,
          ),
        ),
      ms,
    )
  })

  try {
    return await Promise.race([op(), ceiling])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Minimal decryption surface the mail pipeline needs (gift-wrap unwrapping).
export interface Signer {
  decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string>
}

export function signerFromActive(active: ActiveSigner): Signer {
  return {
    decrypt: (counterpartyPubkey, ciphertext) =>
      withSignerTimeout('nip44Decrypt', () =>
        active.nip44Decrypt(counterpartyPubkey, ciphertext),
      ),
  }
}
