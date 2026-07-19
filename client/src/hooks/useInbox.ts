import { useEffect } from 'react'
import { useAccountStore } from '@/store/account'
import { useMailStore } from '@/store/mail'
import { getPool, fetchDmRelays } from '@/lib/nostr/relays'
import { decodeGiftWrap } from '@/lib/mail/receive'
import { signerFromActive } from '@/lib/nostr/signer'
import { KIND_GIFTWRAP, KIND_MAIL } from '@/lib/nostr/constants'
import type { Event, Filter } from 'nostr-tools'

export function useInbox() {
  const { account, active } = useAccountStore()
  const addEmail = useMailStore((s) => s.addEmail)

  useEffect(() => {
    if (!account || !active) return

    let alive = true
    const pool = getPool()
    const signer = signerFromActive(active)

    async function subscribe() {
      const relays = await fetchDmRelays(account!.pubkey)

      const filter: Filter = {
        kinds: [KIND_GIFTWRAP],
        '#p': [account!.pubkey],
        '#k': [String(KIND_MAIL)],
      } as Filter

      const sub = pool.subscribeMany(relays, filter, {
        onevent: async (event: Event) => {
          if (!alive) return
          const email = await decodeGiftWrap(event, signer)
          if (email) addEmail(email)
        },
      })

      return sub
    }

    const subPromise = subscribe().catch(console.error)
    return () => {
      alive = false
      subPromise.then((sub) => sub?.close())
    }
  }, [account, active, addEmail])
}
