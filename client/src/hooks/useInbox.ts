import { useEffect } from 'react'
import { useAccountStore } from '@/store/account'
import { useMailStore } from '@/store/mail'
import { getLocalRelay } from '@/lib/nostr/localRelay'
import { decodeGiftWrap } from '@/lib/mail/receive'
import { signerFromActive } from '@/lib/nostr/signer'
import { KIND_GIFTWRAP, KIND_MAIL } from '@/lib/nostr/constants'
import type { Filter } from 'nostr-tools'

export function useInbox() {
  const { account, active } = useAccountStore()
  const addEmail = useMailStore((s) => s.addEmail)

  useEffect(() => {
    if (!account || !active) return

    let alive = true
    const signer = signerFromActive(active)

    const filter: Filter = {
      kinds: [KIND_GIFTWRAP],
      '#p': [account.pubkey],
      '#k': [String(KIND_MAIL)],
    } as Filter

    // Cache replay → EOSE → live tail. Cached events re-deliver on every
    // mount, so dedup BEFORE decrypting — nip44 per gift wrap is expensive
    // (one NIP-46 round-trip each for remote-signer users).
    const handle = getLocalRelay().observe([filter], {
      onEvent: async (event) => {
        if (!alive) return
        if (useMailStore.getState().seenIds.has(event.id)) return
        const email = await decodeGiftWrap(event, signer)
        if (email) addEmail(email)
      },
    })

    return () => {
      alive = false
      handle.unobserve()
    }
  }, [account, active, addEmail])
}
