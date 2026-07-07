/// <reference types="vite/client" />

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
