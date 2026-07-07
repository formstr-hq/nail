import { nip44 } from 'nostr-tools'

export interface Signer {
  decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string>
}

export function nsecSigner(sk: Uint8Array): Signer {
  return {
    async decrypt(counterpartyPubkey, ciphertext) {
      const key = nip44.getConversationKey(sk, counterpartyPubkey)
      return nip44.decrypt(ciphertext, key)
    },
  }
}

export function nip07Signer(): Signer {
  return {
    async decrypt(counterpartyPubkey, ciphertext) {
      if (!window.nostr?.nip44) throw new Error('Extension does not support NIP-44')
      return window.nostr.nip44.decrypt(counterpartyPubkey, ciphertext)
    },
  }
}

export function signerFromAccount(method: 'nip07' | 'nsec', sk: Uint8Array | null): Signer {
  if (method === 'nip07') return nip07Signer()
  if (!sk) throw new Error('No secret key available')
  return nsecSigner(sk)
}
