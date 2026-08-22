import { createSigner } from '@formstr/signer'
import type { ActiveSigner } from '@formstr/signer'
import { NostrSignerPlugin } from 'nostr-signer-capacitor-plugin'

// Single signer instance for the whole app. appName/appUrl are what remote
// signers (NIP-46 nostrconnect) display on their approval prompt. The Android
// signer plugin powers NIP-55 (Amber) login inside the native app — its
// exported surface is already the positional shape @formstr/signer calls, so it
// drops straight in. Inert on web, where that method isn't offered.
export const nostrSigner = createSigner({
  appName: 'Mail by Formstr',
  appUrl: 'https://mailstr.app',
  androidSignerPlugin: NostrSignerPlugin,
})

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
          new Error(
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
