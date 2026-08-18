import { useCallback, useEffect, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useMailStore } from '@/store/mail'
import { getLocalRelay, syncAccountRelays } from '@/lib/nostr/localRelay'
import { decodeGiftWrap } from '@/lib/mail/receive'
import { protocolSigner } from '@/lib/nostr/protocol-signer'
import { KIND_GIFTWRAP, DEFAULT_RELAYS, withHardcodedRelay } from '@/lib/nostr/constants'
import type { Event, Filter } from 'nostr-tools'

/**
 * What the mailbox can honestly say about itself right now.
 *
 * `decoding` is tracked separately from the phase because being subscribed is
 * not the same as having read anything: each wrap costs a signer call, and
 * behind a NIP-46 bunker that is a relay round-trip apiece. An inbox that is
 * live but still working through a backlog must not render as empty.
 */
export type InboxStatus =
  | { phase: 'connecting'; decoding: number }
  | { phase: 'live'; relays: string[]; decoding: number }
  | { phase: 'error'; message: string; decoding: number }

export function useInbox(bridgePubkey: string | null) {
  const { account, active } = useAccountStore()
  const addEmail = useMailStore((s) => s.addEmail)
  const [status, setStatus] = useState<InboxStatus>({ phase: 'connecting', decoding: 0 })
  // Bumped by retry() to re-run the effect after a failed connect.
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!account || !active) return

    let alive = true
    setStatus({ phase: 'connecting', decoding: 0 })

    const relay = getLocalRelay()
    const signer = protocolSigner(active)

    // Decrypting a gift wrap costs one signer call, and with a NIP-46 bunker
    // that is a full relay round-trip. The subscription has no `since`, so a
    // reload replays every wrap the relays hold and would fire all of those at
    // the signer simultaneously — enough to swamp a bunker and leave the inbox
    // silently empty. Run a bounded number at a time instead.
    const MAX_CONCURRENT_DECRYPTS = 3
    const queue: Event[] = []
    let running = 0
    let undecodable = 0

    // Reported to the UI as "still reading N messages". Counts queued plus
    // in-flight, so it only reaches zero when the backlog is genuinely done.
    const reportDecoding = () => {
      if (!alive) return
      setStatus((s) => ({ ...s, decoding: queue.length + running }))
    }

    const pump = () => {
      while (alive && running < MAX_CONCURRENT_DECRYPTS && queue.length) {
        const event = queue.shift()!
        running += 1
        void decodeGiftWrap(event, signer, bridgePubkey, account!.pubkey)
          .then((outcome) => {
            if (!alive) return
            if ('email' in outcome) {
              addEmail(outcome.email)
              return
            }
            // Routine: relays hand us every wrap p-tagged to us, and most are
            // other people's mail we cannot read. Only the rest is a signal.
            if (outcome.failure.routine) return
            undecodable += 1
            console.warn(
              `[inbox] rejected wrap ${event.id.slice(0, 8)}: ${outcome.failure.reason} ` +
                `(${undecodable} so far)`,
            )
          })
          .finally(() => {
            running -= 1
            pump()
            reportDecoding()
          })
      }
      reportDecoding()
    }

    let cleanup: (() => void) | undefined
    try {
      // Reactively track this account's read (10002) and DM inbox (10050) relays;
      // the worker reopens the kind-1059 stream on the DM relays as they arrive.
      // No brittle one-shot lookup blocking the critical path. The callback
      // surfaces the effective fetch set (10050, falling back to the read floor)
      // so the relay count shown in the UI tracks what we actually read from,
      // not the static default.
      const relaysHandle = syncAccountRelays(account.pubkey, (relays) => {
        if (!alive) return
        setStatus((s) => (s.phase === 'live' ? { ...s, relays } : s))
      })

      const filter: Filter = {
        kinds: [KIND_GIFTWRAP],
        '#p': [account.pubkey],
      } as Filter

      // Cache replays first (persisted wraps, offline-safe), then the worker
      // syncs upstream and streams the live tail through the same callback.
      const sub = relay.observe([filter], {
        onEvent: (event: Event) => {
          if (!alive) return
          // Skip anything already decoded — otherwise every reload pays the
          // signer round-trip again for mail we have already read.
          if (useMailStore.getState().seenIds.has(event.id)) return
          queue.push(event)
          pump()
        },
      })

      cleanup = () => {
        relaysHandle.unobserve()
        sub.unobserve()
      }
      if (alive) {
        setStatus({ phase: 'live', relays: withHardcodedRelay(DEFAULT_RELAYS), decoding: queue.length + running })
      }
    } catch (err) {
      console.error(err)
      if (alive) {
        setStatus({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err),
          decoding: 0,
        })
      }
    }

    return () => {
      alive = false
      cleanup?.()
    }
  }, [account, active, addEmail, bridgePubkey, attempt])

  return { status, retry }
}
