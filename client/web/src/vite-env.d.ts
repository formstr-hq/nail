/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WS_BASE_URL?: string;
  readonly VITE_MAIL_DOMAIN?: string;
  readonly VITE_MAILS_URL?: string;
  readonly VITE_API_CANONICAL_BASE_URL?: string;
  readonly VITE_BRIDGE_DOMAIN?: string;
  /** Comma-separated relay override (e2e points the app at a local mock). */
  readonly VITE_DEFAULT_RELAYS?: string;
  /** "1" in a store build (Play / App Store): no Lightning, no card code. */
  readonly VITE_STORE_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  nostr?: {
    getPublicKey(): Promise<string>;
    signEvent(event: object): Promise<object>;
    nip44?: {
      encrypt(pubkey: string, plaintext: string): Promise<string>;
      decrypt(pubkey: string, ciphertext: string): Promise<string>;
    };
  };
}
// Resolved by a Vite alias to the open or the store privacy policy.
declare module "@privacy-policy.md?raw" {
  const content: string;
  export default content;
}
