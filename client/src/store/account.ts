import { create } from 'zustand'
import type { ActiveSigner, StoredAccount } from '@formstr/signer'
import { nostrSigner, withSignerTimeout } from '@/lib/nostr/signer'
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

/** Per attempt. Two of these is still far below the 20s app-wide ceiling. */
const WARMUP_TIMEOUT_MS = 8000
const WARMUP_ATTEMPTS = 2

/**
 * Force a real round trip to a resumed NIP-46 bunker, and absorb the first
 * lost response.
 *
 * Two problems make this necessary on resume, neither of which exists after a
 * fresh pairing:
 *
 * 1. `unlock()` hands the wrapper a cached pubkey, so `getPublicKey()` answers
 *    from memory. It is not a health check — it cannot fail, and cannot tell
 *    us whether the bunker is reachable at all.
 *
 * 2. `unlock()` deliberately skips NIP-46 `connect` (re-sending it prompts the
 *    user for approval on every cold start). But `connect` is what establishes
 *    the subscription that bunker responses arrive on. Without it, the first
 *    `sendRequest` calls `setupSubscription()` and publishes immediately
 *    without awaiting it, so the relay often has no live subscription when the
 *    bunker answers and the reply is dropped. That request then hangs, because
 *    nostr-tools' `sendRequest` has no timeout of its own.
 *
 * Encrypting to ourselves is the cheapest request that actually exercises the
 * path. The first attempt is expected to fail sometimes — it is what warms the
 * subscription — so a single retry is the fix rather than a workaround.
 */
async function warmUpRemoteSigner(active: ActiveSigner, pubkey: string): Promise<boolean> {
  for (let attempt = 1; attempt <= WARMUP_ATTEMPTS; attempt++) {
    try {
      await withSignerTimeout(
        'nip46 warm-up',
        () => active.nip44Encrypt(pubkey, 'ping'),
        WARMUP_TIMEOUT_MS,
      )
      return true
    } catch {
      console.warn(`[account] bunker warm-up attempt ${attempt}/${WARMUP_ATTEMPTS} failed`)
    }
  }
  return false
}

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

        // For a bunker the check above proves nothing — getPublicKey() is
        // served from the cached value unlock() supplied. Only a real request
        // establishes whether the remote signer is reachable, and issuing one
        // here also warms the response subscription so the app's own first
        // decrypt doesn't lose its reply. See warmUpRemoteSigner.
        if (active && account?.method === 'nip46') {
          const reachable = await warmUpRemoteSigner(active, account.pubkey)
          if (!reachable) {
            console.error('[account] bunker did not respond; session needs re-pairing')
            active = null
          }
        }
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
