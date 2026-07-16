import { createSigner } from '@formstr/signer'
import type { ActiveSigner } from '@formstr/signer'

// Single signer instance for the whole app. appName/appUrl are what remote
// signers (NIP-46 nostrconnect) display on their approval prompt.
export const nostrSigner = createSigner({
  appName: 'Mail by Formstr',
  appUrl: 'https://mailstr.app',
})

// Minimal decryption surface the mail pipeline needs (gift-wrap unwrapping).
export interface Signer {
  decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string>
}

export function signerFromActive(active: ActiveSigner): Signer {
  return {
    decrypt: (counterpartyPubkey, ciphertext) =>
      active.nip44Decrypt(counterpartyPubkey, ciphertext),
  }
}
