import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import type { NostrAccount } from '@/types/nostr'

interface AccountState {
  account: NostrAccount | null
  sk: Uint8Array | null   // only set for nsec logins; never persisted
  login: (method: 'nip07' | 'nsec', nsec?: string) => Promise<void>
  logout: () => void
  generateAndLogin: () => void
}

export const useAccountStore = create<AccountState>()(
  persist(
    (set) => ({
      account: null,
      sk: null,

      login: async (method, nsec) => {
        if (method === 'nip07') {
          if (!window.nostr) throw new Error('No NIP-07 extension found')
          const pubkey = await window.nostr.getPublicKey()
          set({
            account: { pubkey, npub: nip19.npubEncode(pubkey), method: 'nip07' },
            sk: null,
          })
        } else if (method === 'nsec' && nsec) {
          const decoded = nip19.decode(nsec)
          if (decoded.type !== 'nsec') throw new Error('Invalid nsec')
          const sk = decoded.data as Uint8Array
          const pubkey = getPublicKey(sk)
          set({
            account: { pubkey, npub: nip19.npubEncode(pubkey), method: 'nsec' },
            sk,
          })
        }
      },

      logout: () => set({ account: null, sk: null }),

      generateAndLogin: () => {
        const sk = generateSecretKey()
        const pubkey = getPublicKey(sk)
        set({
          account: { pubkey, npub: nip19.npubEncode(pubkey), method: 'nsec' },
          sk,
        })
      },
    }),
    {
      name: 'nail-account',
      // Never persist the secret key
      partialize: (state) => ({ account: state.account }),
    },
  ),
)
