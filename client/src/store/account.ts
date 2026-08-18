import { create } from 'zustand'
import type { ActiveSigner, StoredAccount } from '@formstr/signer'
import { nostrSigner, withSignerTimeout } from '@/lib/nostr/signer'
import { getSignerPool } from '@/lib/nostr/signerPool'
import { useMailStore } from '@/store/mail'

interface AccountState {
  account: StoredAccount | null
  active: ActiveSigner | null
  /** Every persisted account, for the in-app user switcher. */
  accounts: StoredAccount[]
  ready: boolean
  init: () => Promise<void>
  refresh: () => void
  unlockNcryptsec: (passphrase: string) => Promise<void>
  switchTo: (pubkey: string) => Promise<void>
  logout: () => Promise<void>
  removeAccount: (pubkey: string) => Promise<void>
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
  accounts: [],
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
      active = await nostrSigner.unlock({ pool: getSignerPool() })
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
    set({
      account: nostrSigner.getActiveAccount(),
      active,
      accounts: nostrSigner.listAccounts(),
      ready: true,
    })
  },

  refresh: () =>
    set({
      account: nostrSigner.getActiveAccount(),
      active: nostrSigner.getActiveSigner(),
      accounts: nostrSigner.listAccounts(),
    }),

  unlockNcryptsec: async (passphrase) => {
    const account = nostrSigner.getActiveAccount()
    if (!account?.ncryptsec) throw new Error('No encrypted key to unlock')
    await nostrSigner.loginWithNcryptsec(account.ncryptsec, passphrase)
    get().refresh()
  },

  /**
   * Make another already-signed-in account the active one.
   *
   * `switchAccount` clears the in-memory signer — the target account starts
   * locked — so we immediately try the same silent unlock `init` uses. For an
   * extension / NIP-46 / Android account that reconstructs a working signer
   * (with the bunker warm-up so its first decrypt isn't lost). An `ncryptsec`
   * account can't be unlocked without its passphrase: `active` stays null,
   * App falls back to LoginPage, and its UnlockForm prompts for exactly this
   * now-active account. Either way the previous account's mail is cleared so
   * the two inboxes never bleed together.
   */
  switchTo: async (pubkey) => {
    if (pubkey === get().account?.pubkey) return
    await nostrSigner.switchAccount(pubkey)
    useMailStore.getState().clear()

    let active: ActiveSigner | null = null
    try {
      active = await nostrSigner.unlock({ pool: getSignerPool() })
      const account = nostrSigner.getActiveAccount()
      if (active && account) {
        const pk = await active.getPublicKey()
        if (pk !== account.pubkey) active = null
        if (account.method === 'extension' && !window.nostr?.nip44) active = null
        if (active && account.method === 'nip46') {
          const reachable = await warmUpRemoteSigner(active, account.pubkey)
          if (!reachable) active = null
        }
      }
    } catch {
      active = null
    }

    set({
      account: nostrSigner.getActiveAccount(),
      active,
      accounts: nostrSigner.listAccounts(),
    })
  },

  logout: async () => {
    await nostrSigner.logout()
    useMailStore.getState().clear()
    get().refresh()
  },

  /**
   * Forget a stored account, active or not.
   *
   * `logout(pubkey)` deletes exactly that account from storage. Only the active
   * account's mail lives in the mail store, so we clear it only when the
   * removed account was the active one — removing a background account leaves
   * the current inbox untouched.
   */
  removeAccount: async (pubkey) => {
    const wasActive = pubkey === get().account?.pubkey
    await nostrSigner.logout(pubkey)
    if (wasActive) useMailStore.getState().clear()
    get().refresh()
  },
}))
