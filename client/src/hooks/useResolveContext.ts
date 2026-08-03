import { useEffect, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { buildResolveContext } from '@/lib/nostr/bridge'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'
import { pubkeyToNpub } from '@/lib/nostr/giftwrap'
import type { ResolveContext } from '@/lib/mail/resolve'

/**
 * The routing context for the signed-in user: which domains are local, which
 * domain their own address lives on, and which bridge relays their outbound
 * legacy mail.
 *
 * Resolved once here rather than per-send, because it costs a NIP-05 lookup
 * and the answer changes only when the user's address or bridge override does.
 * `bridgePubkey` stays null until the lookup lands (and if it fails), and
 * callers must treat null as "cannot send to legacy addresses" rather than
 * sending anyway.
 */
export function useResolveContext(): ResolveContext {
  const { account } = useAccountStore()
  const { settings } = useSettingsStore()

  const senderAddress =
    settings.senderAddress ||
    (account ? `${pubkeyToNpub(account.pubkey)}@${BRIDGE_DOMAIN}` : `@${BRIDGE_DOMAIN}`)
  const override = settings.bridgeDomains?.[0]

  const [ctx, setCtx] = useState<ResolveContext>({
    localDomains: [BRIDGE_DOMAIN],
    ownDomain: BRIDGE_DOMAIN,
    bridgePubkey: null,
  })

  useEffect(() => {
    let alive = true
    buildResolveContext(senderAddress, override)
      .then((resolved) => {
        if (alive) setCtx(resolved)
      })
      .catch((err) => console.error('[bridge] could not resolve outbound bridge', err))
    return () => {
      alive = false
    }
  }, [senderAddress, override])

  return ctx
}
