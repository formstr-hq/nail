import { useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '@/app/store/settings'
import { useBridgeStore } from '@/app/store/bridge'
import {
  bridgeDomainOf,
  bridgeTargets,
  resolveBridgeProbes,
  senderBridge,
  type BridgeProbe,
} from '@/app/lib/nostr/bridge'
import { forgetNip05 } from '@/app/lib/nostr/nip05'
import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import { splitAddress } from '@protocol'
import type { ResolveContext } from '@/app/lib/mail/resolve'

/**
 * The routing context for one From address, as the composer needs it.
 *
 * `ctx.bridgePubkey` is the bridge OUTBOUND mail from that address goes
 * through. It stays null until that bridge resolves, and callers must treat
 * null as "cannot send to legacy addresses" rather than sending anyway.
 */
export interface SenderResolve {
  ctx: ResolveContext
  /** True while the From's bridge is still being looked up. */
  resolving: boolean
  /** Non-null once its lookup settled with no usable outbound bridge. */
  bridgeError: string | null
}

/**
 * The live state of every bridge this account depends on.
 *
 * Resolution is asynchronous and can have three outcomes per bridge —
 * in progress, resolved, or failed — and the UI must reflect whichever is
 * current: mail already on screen re-derives its sender proof when a bridge
 * lands (see useSenderIdentity), and the composer distinguishes "still
 * resolving" from "could not resolve" rather than failing immediately.
 */
export interface ResolveContextState {
  /** Live per-bridge state, in target order. */
  probes: BridgeProbe[]
  /** The routing context for mail sent from `fromAddress`. */
  forSender: (fromAddress: string) => SenderResolve
  /** Re-run every probe, dropping cached failures (the manual "reload"). */
  retry: () => void
}

/**
 * @param ownedAddresses The signed-in user's own mail addresses. A bridge is
 *   looked up for each of their domains, because the composer's From — not a
 *   saved setting — decides which bridge carries a message. Their domains are
 *   also `localDomains`: a workspace address like `alice@acme.com` is served
 *   by the same bridge, so a recipient on it is reachable over Nostr.
 */
export function useResolveContext(ownedAddresses: string[] = []): ResolveContextState {
  const { settings } = useSettingsStore()
  const probes = useBridgeStore((s) => s.probes)
  const setProbes = useBridgeStore((s) => s.setProbes)
  const upsertProbe = useBridgeStore((s) => s.upsertProbe)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const lastAttempt = useRef(attempt)

  // Joined keys stand in for the array identities (fresh arrays each render).
  const domainsKey = Array.from(new Set(ownedAddresses.map(bridgeDomainOf))).sort().join(',')
  const overridesKey = (settings.bridgeDomains ?? []).join(',')

  useEffect(() => {
    let alive = true
    const domains = domainsKey ? domainsKey.split(',') : []
    const targets = bridgeTargets(domains, settings.bridgeDomains)
    // A manual retry must actually re-fetch: a timed-out lookup is cached as a
    // negative, and without this Retry would replay that failure for a day.
    if (attempt !== lastAttempt.current) {
      lastAttempt.current = attempt
      for (const t of targets) forgetNip05(t.target)
    }
    // Seed every target as resolving so the UI shows progress immediately and
    // stale probe rows from a previous address set cannot linger.
    setProbes(targets.map((t) => ({ ...t, status: 'resolving' })))

    resolveBridgeProbes(targets, (probe) => {
      if (alive) upsertProbe(probe)
    })

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainsKey, overridesKey, attempt, setProbes, upsertProbe])

  const ownedDomains = ownedAddresses
    .map((a) => splitAddress(a)?.domain)
    .filter((d): d is string => Boolean(d))

  const forSender = useCallback(
    (fromAddress: string): SenderResolve => {
      const ownDomain = fromAddress ? bridgeDomainOf(fromAddress) : BRIDGE_DOMAIN
      const localDomains = Array.from(new Set([BRIDGE_DOMAIN, ownDomain, ...ownedDomains]))
      const { bridgePubkey, resolving, failed } = senderBridge(probes, fromAddress)
      const which = failed.map((p) => p.label).join(', ')
      const bridgeError =
        !resolving && bridgePubkey === null
          ? `The mail bridge${which ? ` (${which})` : ''} did not answer, so email to addresses outside Nostr can’t be sent right now.`
          : null
      return { ctx: { localDomains, ownDomain, bridgePubkey }, resolving, bridgeError }
    },
    // ownedDomains is derived from ownedAddresses; domainsKey tracks it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [probes, domainsKey],
  )

  return { probes, forSender, retry }
}
