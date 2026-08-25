import type { Event, UnsignedEvent } from "nostr-tools";

/** An unsigned nostr event. `id` is set; `sig` is deliberately absent. */
export interface Rumor {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * The key operations the protocol needs, abstracted so the browser can back
 * them with NIP-07/NIP-46 and the bridge with a raw secret key.
 */
export interface ProtocolSigner {
  getPublicKey(): Promise<string>;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<Event>;
}

/**
 * Why an unwrap failed. `not-for-us` is routine — relays deliver every wrap
 * p-tagged to us, including ones we cannot decrypt. Every other value means
 * something is broken or hostile and MUST be logged and counted (§8).
 */
export type UnwrapFailure =
  | "not-for-us"
  | "malformed-seal"
  | "bad-seal-signature"
  | "wrong-seal-kind"
  | "malformed-rumor"
  | "author-mismatch"
  | "wrong-rumor-kind"
  | "wrapkey-mismatch"
  | "expired";

export type UnwrapResult =
  | {
      ok: true;
      seal: Event;
      rumor: Rumor;
      /**
       * Hex of the wrap author's ephemeral signing key, when the sender
       * embedded it (WRAP_KEY_TAG, mail.ts). Lets the recipient author a
       * NIP-09 kind-5 that relays will actually honor for this wrap. Absent
       * on mail wrapped before the tag existed.
       */
      wrapSecret?: string;
    }
  | { ok: false; reason: UnwrapFailure };
