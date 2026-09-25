import { useCallback, useEffect, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useSettingsStore } from '@/app/store/settings'
import { useBridgeStore } from '@/app/store/bridge'
import {
  bridgeTargets,
  outboundBridge,
  resolveBridgeProbes,
  type BridgeProbe,
} from '@/app/lib/nostr/bridge'
import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import { splitAddress } from '@protocol'
import { pubkeyToNpub } from '@/app/lib/nostr/giftwrap'
import type { ResolveContext } from '@/app/lib/mail/resolve'

/**
 * The routing context for the signed-in user plus the live state of every
 * bridge it depends on.
 *
 * Resolution is asynchronous and can have three outcomes per bridge —
 * in progress, resolved, or failed — and the UI must reflect whichever is
 * current: mail already on screen re-derives its sender proof when a bridge
 * lands (see useSenderIdentity), and the composer distinguishes "still
 * resolving" from "could not resolve" rather than failing immediately.
 *
 * `ctx.bridgePubkey` is the bridge OUTBOUND mail goes through (an override
 * wins, else the default). It stays null until that target resolves, and
 * callers must treat null as "cannot send to legacy addresses" rather than
 * sending anyway.
 */
export interface ResolveContextState {
  ctx: ResolveContext
  /** Live per-bridge state, in target order (default first). */
  probes: BridgeProbe[]
  /** True while any bridge probe is in flight (or hasn't started yet). */
  resolving: boolean
  /** Non-null once resolution settled with no usable outbound bridge. */
  bridgeError: string | null
  /** Re-run every probe (the manual "reload" path). */
  retry: () => void
}

/**
 * @param ownedAddresses The signed-in user's own mail addresses. Their
 *   domains are added to `localDomains`: a workspace address like
 *   `alice@acme.com` is served by the same bridge, so a From on it is legal
 *   for external mail — and a recipient on it is reachable over Nostr, not
 *   legacy. Without this the composer rejects a perfectly valid workspace
 *   sender ("not a registered alias") and misroutes workspace recipients.
 */
export function useResolveContext(ownedAddresses: string[] = []): ResolveContextState {
  const { account } = useAccountStore()
  const { settings } = useSettingsStore()
  const probes = useBridgeStore((s) => s.probes)
  const setProbes = useBridgeStore((s) => s.setProbes)
  const upsertProbe = useBridgeStore((s) => s.upsertProbe)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const senderAddress =
    settings.senderAddress ||
    (account ? `${pubkeyToNpub(account.pubkey)}@${BRIDGE_DOMAIN}` : `@${BRIDGE_DOMAIN}`)
  const overridesKey = (settings.bridgeDomains ?? []).join(',')

  useEffect(() => {
    let alive = true
    const targets = bridgeTargets(senderAddress, settings.bridgeDomains)
    // Seed every target as resolving so the UI shows progress immediately and
    // stale probe rows from a previous sender address cannot linger.
    setProbes(targets.map((t) => ({ ...t, status: 'resolving' })))

    resolveBridgeProbes(targets, (probe) => {
      if (alive) upsertProbe(probe)
    })

    return () => {
      alive = false
    }
    // overridesKey stands in for the array identity (a fresh array each load).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senderAddress, overridesKey, attempt, setProbes, upsertProbe])

  const ownDomain = senderAddress.includes('@')
    ? senderAddress.slice(senderAddress.lastIndexOf('@') + 1)
    : BRIDGE_DOMAIN
  // Workspace domains the user holds an address on are served by the same
  // bridge, so they belong in localDomains alongside the platform domain.
  const ownedDomains = ownedAddresses
    .map((a) => splitAddress(a)?.domain)
    .filter((d): d is string => Boolean(d))
  const localDomains = Array.from(
    new Set([BRIDGE_DOMAIN, ownDomain, ...ownedDomains]),
  )
  const bridgePubkey = outboundBridge(probes)
  // Before the first pass lands, probes is empty — that is "still resolving",
  // not "failed", so the composer must not flash an unavailable error.
  const resolving = probes.length === 0 || probes.some((p) => p.status === 'resolving')
  const bridgeError =
    !resolving && bridgePubkey === null
      ? 'Outbound bridge could not be resolved — external email is unavailable.'
      : null

  return {
    ctx: { localDomains, ownDomain, bridgePubkey },
    probes,
    resolving,
    bridgeError,
    retry,
  }
}
