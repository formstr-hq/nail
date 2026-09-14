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