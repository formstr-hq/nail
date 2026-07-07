import { useEffect } from 'react'
import { useAccountStore } from '@/store/account'
import { useMailStore } from '@/store/mail'
import { getPool, fetchDmRelays } from '@/lib/nostr/relays'
import { decodeGiftWrap } from '@/lib/mail/receive'
import { signerFromAccount } from '@/lib/nostr/signer'
import { KIND_GIFTWRAP, KIND_MAIL } from '@/lib/nostr/constants'
import type { Event, Filter } from 'nostr-tools'

export function useInbox() {
  const { account, sk } = useAccountStore()
  const addEmail = useMailStore((s) => s.addEmail)

  useEffect(() => {
    if (!account) return

    let active = true
    const pool = getPool()
    const signer = signerFromAccount(account.method, sk)

    async function subscribe() {
      const relays = await fetchDmRelays(account!.pubkey)

      const filter: Filter = {
        kinds: [KIND_GIFTWRAP],
        '#p': [account!.pubkey],
        '#k': [String(KIND_MAIL)],
      } as Filter

      const sub = pool.subscribeMany(relays, filter, {
        onevent: async (event: Event) => {
          if (!active) return
          const email = await decodeGiftWrap(event, signer)
          if (email) addEmail(email)
        },
      })

      return sub
    }

    const subPromise = subscribe().catch(console.error)
    return () => {
      active = false
      subPromise.then((sub) => sub?.close())
    }
  }, [account, sk, addEmail])
}
