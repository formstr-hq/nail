import { useEffect } from 'react'
import { useAccountStore } from '@/store/account'
import { useMailStore } from '@/store/mail'
import { getPool, fetchDmRelays } from '@/lib/nostr/relays'
import { decodeGiftWrap } from '@/lib/mail/receive'
import { protocolSigner } from '@/lib/nostr/protocol-signer'
import { KIND_GIFTWRAP } from '@/lib/nostr/constants'
import type { Event, Filter } from 'nostr-tools'

export function useInbox(bridgePubkey: string | null) {
  const { account, active } = useAccountStore()
  const addEmail = useMailStore((s) => s.addEmail)

  useEffect(() => {
    if (!account || !active) return

    let alive = true
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

    const pump = () => {
      while (alive && running < MAX_CONCURRENT_DECRYPTS && queue.length) {
        const event = queue.shift()!
        running += 1
        void decodeGiftWrap(event, signer, bridgePubkey)
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
          })
      }
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

      return sub
    }

    const subPromise = subscribe().catch(console.error)
    return () => {
      alive = false
      subPromise.then((sub) => sub?.close())
    }
  }, [account, active, addEmail, bridgePubkey])
}
