import { create } from 'zustand'
import type { ActiveSigner, StoredAccount } from '@formstr/signer'
import { nostrSigner } from '@/lib/nostr/signer'
import { getPool } from '@/lib/nostr/relays'

interface AccountState {
  account: StoredAccount | null
  active: ActiveSigner | null
  ready: boolean
  init: () => Promise<void>
  refresh: () => void
  unlockNcryptsec: (passphrase: string) => Promise<void>
  logout: () => Promise<void>
}

let initialized = false

export const useAccountStore = create<AccountState>()((set, get) => ({
  account: null,
  active: null,
  ready: false,

  // No global onChange subscription: createAccount() emits 'login' while the
  // ncryptsec backup panel is still on screen, and refreshing then would
  // unmount the login UI before the user backed up their key. State is
  // refreshed explicitly instead — LoginPage's onLogin (fired after the
  // backup ack), unlockNcryptsec, and logout.
  init: async () => {
    if (initialized) return
    initialized = true
    let active: ActiveSigner | null = null
    try {
      // Silent resume for extension / NIP-46 sessions. ncryptsec accounts
      // stay locked by design — LoginPage drives the passphrase prompt.
      active = await nostrSigner.unlock({ pool: getPool() })
      // unlock() reconstructs the signer from stored state without checking
      // it still works (uninstalled extension, extension switched to another
      // account, extension without nip44). Probe before trusting it, or the
      // app renders a mailbox whose every decrypt silently fails.
      if (active) {
        const account = nostrSigner.getActiveAccount()
        const pubkey = await active.getPublicKey()
        if (!account || pubkey !== account.pubkey) active = null
        if (account?.method === 'extension' && !window.nostr?.nip44) active = null
      }
    } catch {
      // resume failed — account stays locked, LoginPage handles re-auth
      active = null
    }
    set({ account: nostrSigner.getActiveAccount(), active, ready: true })
  },

  refresh: () =>
    set({
      account: nostrSigner.getActiveAccount(),
      active: nostrSigner.getActiveSigner(),
    }),

  unlockNcryptsec: async (passphrase) => {
    const account = nostrSigner.getActiveAccount()
    if (!account?.ncryptsec) throw new Error('No encrypted key to unlock')
    await nostrSigner.loginWithNcryptsec(account.ncryptsec, passphrase)
    get().refresh()
  },

  logout: async () => {
    await nostrSigner.logout()
    get().refresh()
  },
}))
