import { useEffect } from 'react'
import { useAccountStore } from '@/store/account'
import { useMailStore } from '@/store/mail'
import { getLocalRelay, setLocalRelaySigner } from '@/lib/nostr/localRelay'
import { parseDmRelayTags } from '@/lib/nostr/relays'
import { KIND_DM_RELAYS, DEFAULT_RELAYS } from '@/lib/nostr/constants'

// Binds the local relay to the signed-in account: injects the signer (NIP-42
// AUTH + DataLayer publishes), scopes the worker to the account, and discovers
// the user's kind 10050 DM relay list. 10050 is prune-protected, so on reload
// the cached copy replays instantly (warm start) while the network refreshes it.
export function useLocalRelayLifecycle() {
  const { account, active } = useAccountStore()
  const pubkey = account?.pubkey ?? null

  useEffect(() => {
    if (!pubkey || !active) return

    const dl = getLocalRelay()
    // Fresh mailbox per account session — cached events replay on every
    // login, so stale state from a previous account must never survive.
    useMailStore.getState().clear()
    setLocalRelaySigner(active)
    dl.setActiveAccount(pubkey)

    const handle = dl.observe(
      [{ kinds: [KIND_DM_RELAYS], authors: [pubkey], limit: 1 }],
      {
        onEvent: (event) => {
          const relays = parseDmRelayTags(event)
          if (relays.length) {
            // The user's DM relay list is their relay set for this app:
            // inbox reads and own publishes both target it.
            dl.setDmRelays(relays)
            dl.setUserRelays(relays)
          }
        },
      },
    )

    return () => {
      handle.unobserve()
      setLocalRelaySigner(null)
      dl.setActiveAccount(null)
      dl.setDmRelays([])
      dl.setUserRelays(DEFAULT_RELAYS)
    }
  }, [pubkey, active])
}
