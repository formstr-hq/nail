import type { ActiveSigner } from '@formstr/signer'
import type { ProtocolSigner } from '@protocol'
import { withSignerTimeout } from './signer'

/**
 * Adapts `@formstr/signer` to the shared protocol module's `ProtocolSigner`.
 *
 * Unlike the bridge's `keySigner`, this never sees a secret key — NIP-07,
 * NIP-46 and NIP-49 all keep it out of application code, so every operation
 * is an async call to something else.
 *
 * Each call is bounded. NIP-59 puts two signer round-trips on the send path
 * per recipient (one nip44Encrypt for the seal, one signEvent), so an
 * unresponsive bunker would otherwise pin the UI indefinitely.
 */
export function protocolSigner(active: ActiveSigner): ProtocolSigner {
  return {
    getPublicKey: () => withSignerTimeout('getPublicKey', () => active.getPublicKey()),
    nip44Encrypt: (peerPubkey, plaintext) =>
      withSignerTimeout('nip44Encrypt', () => active.nip44Encrypt(peerPubkey, plaintext)),
    nip44Decrypt: (peerPubkey, ciphertext) =>
      withSignerTimeout('nip44Decrypt', () => active.nip44Decrypt(peerPubkey, ciphertext)),
    signEvent: (event) => withSignerTimeout('signEvent', () => active.signEvent(event)),
  }
}
