import { useCallback, useEffect, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useMailStore } from '@/store/mail'
import { getLocalRelay, syncAccountRelays } from '@/lib/nostr/localRelay'
import { fetchDmRelays } from '@/lib/nostr/relays'
import { decodeMailMeta } from '@/lib/nostr/mailMeta'
import { KIND_MAIL_META } from '@/lib/nostr/constants'
import type { Event, Filter } from 'nostr-tools'

/**
 * Keep the mail store's per-mail state in step with the kind-34578 metadata
 * events on the relays, so read/archived/trashed status follows the user across
 * devices.
 *
 * This mirrors useInbox: the local relay replays cached events first (offline
 * safe), then streams the live tail — so this one subscription covers both the
 * initial load and cross-device updates. Each event costs one signer call to
 * decrypt (behind a NIP-46 bunker, a round-trip apiece), so decrypts run a few
 * at a time and events already decoded are skipped.
 *
 * These events live on the account's DM relays (alongside settings and gift
 * wraps), which aren't part of the general read floor, so the subscription is
 * pointed at them explicitly — otherwise it would read from relays the events
 * were never published to.
 */
export function useMailMeta() {
  const { account, active } = useAccountStore()
  // Bumped by refresh() to tear down and re-open the subscription, which kicks
  // off a fresh upstream sync — the app's only "reload" affordance.
  const [attempt, setAttempt] = useState(0)
  const refresh = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!account || !active) return

    let alive = true
    const relay = getLocalRelay()
    const pubkey = account.pubkey
    const signer = active

    const MAX_CONCURRENT_DECRYPTS = 3
    const queue: Event[] = []
    const seen = new Set<string>()
    let running = 0

    const pump = () => {
      while (alive && running < MAX_CONCURRENT_DECRYPTS && queue.length) {
        const event = queue.shift()!
        running += 1
        void decodeMailMeta(event, pubkey, signer)
          .then((entry) => {
            if (!alive || !entry) return
            useMailStore.getState().hydrateFlags([{ ref: entry.ref, flags: entry.flags }])
          })
          .catch(() => {
            // A single event failing to decode (another app's metadata, a
            // transient signer error) is routine here — skip it.
          })
          .finally(() => {
            running -= 1
            pump()
          })
      }
    }

    const onEvent = (event: Event) => {
      if (!alive || seen.has(event.id)) return
      seen.add(event.id)
      queue.push(event)
      pump()
    }

    // Keep the worker's routing lists warm for this account (same as useInbox).
    const relaysHandle = syncAccountRelays(pubkey)

    let sub: { unobserve: () => void } | undefined
    void (async () => {
      const relays = await fetchDmRelays(pubkey)
      if (!alive) return
      const filter: Filter = { kinds: [KIND_MAIL_META], authors: [pubkey] }
      sub = relay.observe([filter], { onEvent }, { relays })
    })()

    return () => {
      alive = false
      relaysHandle.unobserve()
      sub?.unobserve()
    }
  }, [account, active, attempt])

  return { refresh }
}
