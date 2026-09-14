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
 * p-tagged to us, including ones we cannot decrypt. `signer-error` is a
 * transient failure of the signer itself (timeout, refusal, backend error):
 * also not "broken mail", but NOT routine either — the same wrap may decode on
 * a retry, so callers must retry/report rather than drop it. Every other value
 * means something is broken or hostile and MUST be logged and counted (§8).
 */
export type UnwrapFailure =
  | "not-for-us"
  | "signer-error"
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

/**
 * Marker for a failure of the signer plumbing rather than of the data being
 * decrypted. The browser signer wrapper attaches this to timeouts/refusals so
 * the protocol layer can classify a thrown `nip44Decrypt` as `signer-error`
 * instead of the routine `not-for-us` — otherwise a slow NIP-46 bunker makes
 * real mail look like someone else's ciphertext and it is dropped silently.
 */
export const SIGNER_ERROR_TAG = "mailstr.signer-error";

/** True when `e` was thrown by the signer layer (timeout, refusal, transport). */
export function isSignerFailure(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { tag?: unknown }).tag === SIGNER_ERROR_TAG
  );
}
