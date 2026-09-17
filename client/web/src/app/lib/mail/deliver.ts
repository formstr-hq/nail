import type { Event } from 'nostr-tools'
import type { ActiveSigner } from '@formstr/signer'
import { getLocalRelay } from '@/app/lib/nostr/localRelay'
import { fetchDmRelays } from '@/app/lib/nostr/relays'
import { withSignerTimeout } from '@/app/lib/nostr/signer'
import { fetchMailDiscovery, sendWrapViaApi } from '@/app/lib/nostr/bridgeSend'
import type { Nip98Signer } from '@/lib/nip98'

/**
 * Deliver already-built gift wraps.
 *
 * Wraps addressed to the bridge (their `p` tag is the bridge pubkey) go to the
 * backend's send-wrap API first: the bridge ingests them directly, with no
 * dependence on our relay publish being observed. Every wrap only reaches the
 * relay path when that API is unavailable — discovery didn't answer, the
 * document named a different bridge, or the POST failed. Nostr-direct wraps
 * and the self-copy always go to relays, since the bridge is not their
 * recipient.
 */
export interface DeliverParams {
  wraps: Event[]
  /** Recipient pubkey per wrap, index-aligned with `wraps`. */
  targets: string[]
  senderPubkey: string
  /** The bridge bridge-bound wraps are p-tagged to; null when no bridge. */
  bridgePubkey: string | null
  /** Domain whose `/.well-known/nostr-mail.json` names the send-wrap URL. */
  bridgeDomain: string
  /** The active signer, used to NIP-98 authorize the send-wrap call. */
  active: ActiveSigner
}

export interface DeliverResult {
  /** Bridge wraps accepted by the send-wrap API. */
  viaApi: number
  /** Wraps published to relay(s) — all non-bridge wraps plus fallbacks. */
  viaRelay: number
}

/** Is this wrap addressed to the bridge (as opposed to a Nostr recipient)? */
function isBridgeWrap(wrap: Event, bridgePubkey: string | null): boolean {
  if (!bridgePubkey) return false
  return wrap.tags.some((t) => t[0] === 'p' && t[1] === bridgePubkey)
}

/**
 * Send every bridge wrap through the discovery-named endpoint. Returns the
 * indices NOT accepted, so the caller relays those instead.
 *
 * A discovery document naming a different bridge than the one we sealed to is
 * treated as "API unavailable" rather than an error: the wrap is correctly
 * addressed for the NIP-05-resolved bridge and relay delivery still works.
 */
async function sendBridgeWrapsViaApi(params: {
  wraps: Event[]
  bridgeIndices: number[]
  bridgePubkey: string
  bridgeDomain: string
  active: ActiveSigner
}): Promise<number[]> {
  const { wraps, bridgeIndices, bridgePubkey, bridgeDomain, active } = params
  const discovery = await fetchMailDiscovery(bridgeDomain)
  if (!discovery || discovery.bridgePubkey !== bridgePubkey) return bridgeIndices

  const signer: Nip98Signer = {
    signEvent: (event) => withSignerTimeout('signEvent', () => active.signEvent(event)),
  }

  const failed: number[] = []
  for (const i of bridgeIndices) {
    const result = await sendWrapViaApi({ wrap: wraps[i], discovery, signer })
    if (!result.ok) failed.push(i)
  }
  return failed
}

/**
 * Publish a wrap to its recipient's DM relays. Returns null on success, or a
 * human reason when no relay accepted it. The self-copy is best-effort at the
 * caller: a missing Sent entry is not a delivery failure.
 */
async function publishViaRelay(
  wrap: Event,
  recipientPubkey: string,
): Promise<string | null> {
  const relay = getLocalRelay()
  const relays = await fetchDmRelays(recipientPubkey)
  const outcomes = await relay.publish(wrap, { relays })
  if (outcomes.some((o) => o.status === 'accepted')) return null
  return outcomes.find((o) => o.message)?.message ?? 'no relay accepted it'
}

/**
 * Deliver all wraps. Throws only when a wrap addressed to a real recipient
 * (not the self-copy) could be delivered neither by the API nor by any relay.
 */
export async function deliverWraps(params: DeliverParams): Promise<DeliverResult> {
  const { wraps, targets, senderPubkey, bridgePubkey, bridgeDomain, active } = params

  const bridgeIndices = wraps
    .map((w, i) => (isBridgeWrap(w, bridgePubkey) ? i : -1))
    .filter((i) => i !== -1)

  // API first for bridge wraps; whatever it declines falls back to relays.
  const apiFailed = bridgeIndices.length
    ? await sendBridgeWrapsViaApi({
        wraps,
        bridgeIndices,
        bridgePubkey: bridgePubkey as string,
        bridgeDomain,
        active,
      })
    : []
  const relayIndices = new Set([
    ...wraps.map((_, i) => i).filter((i) => !bridgeIndices.includes(i)),
    ...apiFailed,
  ])

  const viaApi = bridgeIndices.length - apiFailed.length
  const undelivered: string[] = []

  await Promise.all(
    [...relayIndices].map(async (i) => {
      const recipient = targets[i]
      const reason = await publishViaRelay(wraps[i], recipient)
      if (reason && recipient !== senderPubkey) {
        undelivered.push(`${recipient.slice(0, 8)}… (${reason})`)
      }
    }),
  )

  if (undelivered.length) {
    throw new Error(`Could not deliver to: ${undelivered.join('; ')}`)
  }

  return { viaApi, viaRelay: relayIndices.size }
}
