/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BRIDGE_DOMAIN?: string
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  nostr?: {
    getPublicKey(): Promise<string>
    signEvent(event: object): Promise<object>
    nip44?: {
      encrypt(pubkey: string, plaintext: string): Promise<string>
      decrypt(pubkey: string, ciphertext: string): Promise<string>
    }
  }
}
