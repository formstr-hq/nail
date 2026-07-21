import { useCallback, useEffect, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useMailStore } from '@/store/mail'
import { getPool, fetchDmRelays } from '@/lib/nostr/relays'
import { decodeGiftWrap } from '@/lib/mail/receive'
import { protocolSigner } from '@/lib/nostr/protocol-signer'
import { KIND_GIFTWRAP } from '@/lib/nostr/constants'
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

    const pool = getPool()
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

    async function subscribe() {
      const relays = await fetchDmRelays(account!.pubkey)

      const filter: Filter = {
        kinds: [KIND_GIFTWRAP],
        '#p': [account!.pubkey],
      } as Filter

      const sub = pool.subscribeMany(relays, filter, {
        onevent: (event: Event) => {
          if (!alive) return
          // Skip anything already decoded — otherwise every reload pays the
          // signer round-trip again for mail we have already read.
          if (useMailStore.getState().seenIds.has(event.id)) return
          queue.push(event)
          pump()
        },
      })

      if (alive) setStatus({ phase: 'live', relays, decoding: queue.length + running })
      return sub
    }

    const subPromise = subscribe().catch((err: unknown) => {
      console.error(err)
      // fetchDmRelays falls back to defaults rather than throwing, so landing
      // here means the relay list lookup itself failed — a dead pool or an
      // offline browser. Say so instead of rendering a plausible empty inbox.
      if (alive) {
        setStatus({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err),
          decoding: 0,
        })
      }
      return undefined
    })

    return () => {
      alive = false
      subPromise.then((sub) => sub?.close())
    }
  }, [account, active, addEmail, bridgePubkey, attempt])

  return { status, retry }
}
