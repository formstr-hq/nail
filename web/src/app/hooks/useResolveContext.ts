import { useEffect, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useSettingsStore } from '@/app/store/settings'
import { buildResolveContext } from '@/app/lib/nostr/bridge'
import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import { pubkeyToNpub } from '@/app/lib/nostr/giftwrap'
import type { ResolveContext } from '@/app/lib/mail/resolve'

/**
 * The routing context for the signed-in user: which domains are local, which
 * domain their own address lives on, and which bridge relays their outbound
 * legacy mail.
 *
 * Resolved once here rather than per-send, because it costs a NIP-05 lookup
 * and the answer changes only when the user's address or bridge override does.
 * `bridgePubkey` stays null until the lookup lands (and if it fails), and
 * callers must treat null as "cannot send to legacy addresses" rather than
 * sending anyway. A failed lookup is exposed as `bridgeError` so Settings and
 * the composer can say external delivery is unavailable instead of only
 * logging it (audit D4).
 */
export interface ResolveContextState {
  ctx: ResolveContext
  /** Non-null when the bridge lookup failed — legacy outbound is unavailable. */
  bridgeError: string | null
}

export function useResolveContext(): ResolveContextState {
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
  const [bridgeError, setBridgeError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    buildResolveContext(senderAddress, override)
      .then((resolved) => {
        if (!alive) return
        setCtx(resolved)
        // A bridge that resolved to no pubkey is a real failure, not a
        // transient one: external mail cannot be sent this session.
        setBridgeError(
          resolved.bridgePubkey
            ? null
            : 'Outbound bridge could not be resolved — external email is unavailable.',
        )
      })
      .catch((err: unknown) => {
        if (!alive) return
        console.error('[bridge] could not resolve outbound bridge', err)
        setBridgeError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [senderAddress, override])

  return { ctx, bridgeError }
}
