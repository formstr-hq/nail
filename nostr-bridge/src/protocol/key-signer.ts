import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";
import type { Event, UnsignedEvent } from "nostr-tools";
import type { ProtocolSigner } from "./types.js";

/**
 * A ProtocolSigner backed by a secret key held in memory. Used by the bridge
 * (which owns its key outright) and by tests. The browser uses an
 * @formstr/signer-backed implementation instead — the user's key never
 * reaches application code there.
 */
export function keySigner(secretKey: Uint8Array): ProtocolSigner {
  const pubkey = getPublicKey(secretKey);
  return {
    async getPublicKey() {
      return pubkey;
    },
    async nip44Encrypt(peerPubkey: string, plaintext: string) {
      return encrypt(plaintext, getConversationKey(secretKey, peerPubkey));
    },
    async nip44Decrypt(peerPubkey: string, ciphertext: string) {
      return decrypt(ciphertext, getConversationKey(secretKey, peerPubkey));
    },
    async signEvent(event: UnsignedEvent): Promise<Event> {
      return finalizeEvent(event, secretKey);
    },
  };
}
