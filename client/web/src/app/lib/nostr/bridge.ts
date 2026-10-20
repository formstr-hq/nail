import { nip19 } from 'nostr-tools'
import { isNpub, isHexPubkey, splitAddress } from '@protocol'
import { probeNip05, BRIDGE_PROBE_TIMEOUT_MS } from './nip05'
import { BRIDGE_DOMAIN, BRIDGE_NIP05_NAME } from './constants'

/**
 * One bridge this session checks messages against.
 *
 * A user may have more than one: the default `_smtp@<their own mail domain>`
 * (mirroring SMTP — your outgoing server is the one run by your mailbox
 * provider) plus any Settings overrides for self-hosters. The default is
 * always probed, because it is also the bridge that relays a deployment's
 * inbound legacy mail; an override REPLACES it for sending (explicit user
 * config wins) but never hides it from verification.
 */
export interface BridgeTarget {
  /** What the resolver is handed: a NIP-05 address, npub, hex key, or domain. */
  target: string
  /** What the UI calls it — the domain, or the override as the user typed it. */
  label: string
  /** True for the implicit `_smtp@<ownDomain>` target, false for an override. */
  isDefault: boolean
}

/**
 * The resolution state of one bridge, as the UI must show it: in progress,
 * successful, or failed. `resolved` carries the pubkey that backs a sender
 * when a message is sealed by it; `failed` is the honest answer "we could not
 * check this bridge", which is deliberately distinct from "this bridge said
 * no" — see SenderProof's `bridge-unavailable`.
 */
export type BridgeProbe =
  | (BridgeTarget & { status: 'resolving' })
  | (BridgeTarget & { status: 'resolved'; pubkey: string })
  | (BridgeTarget & { status: 'failed'; message: string })

/** Normalize one override into a resolvable target, mirroring resolveBridgeTarget. */
function targetFromOverride(input: string): BridgeTarget {
  const trimmed = input.trim()
  if (isHexPubkey(trimmed) || isNpub(trimmed)) {
    return { target: trimmed, label: trimmed, isDefault: false }
  }
  const address = splitAddress(trimmed) ? trimmed : `${BRIDGE_NIP05_NAME}@${trimmed}`
  return { target: address, label: trimmed, isDefault: false }
}

/** The domain a bridge is looked up on for `address` (`_smtp@<domain>`). */
export function bridgeDomainOf(address: string | undefined): string {
  return (address && splitAddress(address)?.domain?.toLowerCase()) || BRIDGE_DOMAIN
}

/**
 * Every bridge to verify against for this user, deduped case-insensitively.
 *
 * The platform bridge first (it serves every hosted address, so it lands
 * early), then one `_smtp@<domain>` per domain the user owns an address on —
 * the composer's From picks which of them carries a message — then the
 * Settings overrides. Never resolved here: resolution is asynchronous and
 * belongs to the probe runner.
 */
export function bridgeTargets(domains: string[], overrides?: string[]): BridgeTarget[] {
  const all = [BRIDGE_DOMAIN, ...domains.map((d) => d.trim().toLowerCase()).filter(Boolean)]
  const targets: BridgeTarget[] = all.map((domain) => ({
    target: `${BRIDGE_NIP05_NAME}@${domain}`,
    label: domain,
    isDefault: true,
  }))
  for (const override of overrides ?? []) {
    if (!override?.trim()) continue
    targets.push(targetFromOverride(override))
  }

  const seen = new Set<string>()
  return targets.filter((t) => {
    const key = t.target.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Resolve one target to a bridge pubkey, or null when nothing answers.
 *
 * Accepts an npub, a hex pubkey, a NIP-05 address, or a bare domain (meaning
 * `_smtp@<domain>`). Null is fail-closed: callers must treat it as "cannot
 * send to legacy addresses through this bridge" rather than sending anyway.
 */
export async function resolveBridgeTarget(target: string): Promise<string | null> {
  if (isHexPubkey(target)) return target
  if (isNpub(target)) {
    try {
      const decoded = nip19.decode(target)
      return decoded.type === 'npub' ? (decoded.data as string) : null
    } catch {
      return null
    }
  }
  const address = splitAddress(target) ? target : `${BRIDGE_NIP05_NAME}@${target}`
  return probeNip05(address, BRIDGE_PROBE_TIMEOUT_MS)
}

/**
 * Run every probe, reporting each transition as it happens.
 *
 * The callback fires `resolving` up front and then `resolved`/`failed` per
 * target, so the UI can show progress without waiting for the slowest bridge.
 * `resolve` is injectable so the runner is testable without the network.
 */
export async function resolveBridgeProbes(
  targets: BridgeTarget[],
  onProbe: (probe: BridgeProbe) => void,
  resolve: (target: string) => Promise<string | null> = resolveBridgeTarget,
): Promise<void> {
  await Promise.all(
    targets.map(async (t) => {
      onProbe({ ...t, status: 'resolving' })
      const pubkey = await resolve(t.target)
      onProbe(
        pubkey
          ? { ...t, status: 'resolved', pubkey }
          : { ...t, status: 'failed', message: `${t.label} did not answer` },
      )
    }),
  )
}

/**
 * The probes that can carry mail sent from `fromAddress`, in preference order.
 *
 * Precedence mirrors the old single-override rule: when the user configured
 * overrides, only an override may send — falling back to the default would
 * quietly relay through a bridge they did not choose. Otherwise the bridge of
 * the From's own domain, then the platform bridge: a workspace domain is
 * served by the hosted bridge, which itself rejects a From it does not serve.
 * With no From, any default (the old single-sender behaviour).
 */
function candidates(probes: BridgeProbe[], fromAddress?: string): BridgeProbe[] {
  const overrides = probes.filter((p) => !p.isDefault)
  if (overrides.length > 0) return overrides
  const defaults = probes.filter((p) => p.isDefault)
  if (!fromAddress) return defaults.slice(0, 1)
  const own = `${BRIDGE_NIP05_NAME}@${bridgeDomainOf(fromAddress)}`
  const platform = `${BRIDGE_NIP05_NAME}@${BRIDGE_DOMAIN}`
  return [own, platform]
    .filter((t, i, all) => all.indexOf(t) === i)
    .map((t) => defaults.find((p) => p.target.toLowerCase() === t))
    .filter((p): p is BridgeProbe => Boolean(p))
}

/**
 * Which bridge outbound legacy mail from `fromAddress` relays through, given
 * the current probe states. Null means external mail cannot be sent from it
 * right now (still resolving, or failed).
 *
 * A preferred candidate that is still resolving holds the answer at null
 * rather than falling through: a later bridge could route the same From
 * differently once the preferred one lands.
 */
export function outboundBridge(probes: BridgeProbe[], fromAddress?: string): string | null {
  for (const p of candidates(probes, fromAddress)) {
    if (p.status === 'resolved') return p.pubkey
    if (p.status === 'resolving') return null
  }
  return null
}

/**
 * The outbound-bridge state for one From, as the composer must show it: the
 * bridge to use, whether that is still being worked out, and — once settled
 * with none — the bridges that failed, so the error can say which.
 */
export function senderBridge(
  probes: BridgeProbe[],
  fromAddress?: string,
): { bridgePubkey: string | null; resolving: boolean; failed: BridgeProbe[] } {
  const relevant = candidates(probes, fromAddress)
  const bridgePubkey = outboundBridge(probes, fromAddress)
  // Before the first pass lands there are no probes — that is "still
  // resolving", not "failed", so the composer must not flash an error.
  const resolving =
    !bridgePubkey && (relevant.length === 0 || relevant.some((p) => p.status === 'resolving'))
  const failed = bridgePubkey || resolving ? [] : relevant.filter((p) => p.status === 'failed')
  return { bridgePubkey, resolving, failed }
}
