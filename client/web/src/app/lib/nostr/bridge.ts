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

/**
 * Every bridge to verify against for this user, deduped case-insensitively.
 *
 * Built from the signed-in user's own address domain (never resolved here —
 * resolution is asynchronous and belongs to the probe runner) plus the
 * Settings overrides, default first so the primary bridge's state lands early.
 */
export function bridgeTargets(senderAddress: string, overrides?: string[]): BridgeTarget[] {
  const ownDomain = splitAddress(senderAddress)?.domain ?? BRIDGE_DOMAIN
  const targets: BridgeTarget[] = [
    {
      target: `${BRIDGE_NIP05_NAME}@${ownDomain}`,
      label: ownDomain,
      isDefault: true,
    },
  ]
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
 * Which bridge this user's outbound legacy mail relays through, given the
 * current probe states.
 *
 * Precedence mirrors the old single-override rule: when the user configured
 * overrides, only a resolved override may send — falling back to the default
 * would quietly relay through a bridge they did not choose. With no override,
 * the default bridge is the outbound one. Null means external mail cannot be
 * sent right now (still resolving, or failed).
 */
export function outboundBridge(probes: BridgeProbe[]): string | null {
  const overrides = probes.filter((p) => !p.isDefault)
  if (overrides.length > 0) {
    const resolved = overrides.find((p) => p.status === 'resolved')
    return resolved?.status === 'resolved' ? resolved.pubkey : null
  }
  const fallback = probes.find((p) => p.isDefault)
  return fallback?.status === 'resolved' ? fallback.pubkey : null
}
