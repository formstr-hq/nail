import { finalizeEvent } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import type { ActiveSigner } from '@formstr/signer'
import type { Event } from 'nostr-tools'
import { fetchDmRelays } from './relays'
import { getLocalRelay } from './localRelay'
import { withSignerTimeout } from './signer'
import { KIND_GIFTWRAP } from './constants'

/**
 * Permanently deleting one mail: the NIP-09 layer.
 *
 * A mail's ciphertext is a kind-1059 gift wrap held by relays. NIP-09 says a
 * deletion request is only honored when signed by the deleted event's own
 * author, and the wrap's author is a throwaway ephemeral key — so two events
 * are published, covering the two ways a delete can actually land:
 *
 *  1. Signed by the wrap's ephemeral key (handed to us inside the rumor, the
 *     WRAP_KEY_TAG; captured at unwrap into store.wrapKeys). This one WORKS
 *     everywhere NIP-09 is implemented — author matches — including our own
 *     local relay, which purges its IndexedDB copy on author match. Absent for
 *     mail wrapped before the tag existed.
 *  2. Signed by the account key anyway. Most relays ignore it (author does
 *     not match the wrap), but some honor deletion from the addressed party,
 *     and for legacy mail without an embedded key it is the only attempt
 *     possible. Harmless where ignored.
 *
 * Both are best-effort: relays that ignore both keep ciphertext they cannot
 * read. What guarantees the mail stays gone for the USER is elsewhere — the
 * device tombstone plus the `deleted` meta flag (store.markDeleted) that
 * hides it on every relay replay.
 */

export interface DeletionOutcome {
  /** Which deletion events were published, for logging/tests. */
  attempted: ('wrap-author' | 'recipient')[]
  /** True when at least one event was accepted by at least one relay. */
  anyAccepted: boolean
}

export async function publishGiftwrapDeletion(params: {
  giftwrapId: string
  /** Hex of the wrap author's ephemeral key, when the sender embedded it. */
  wrapSecret?: string
  pubkey: string
  active: ActiveSigner
}): Promise<DeletionOutcome> {
  const { giftwrapId, wrapSecret, pubkey, active } = params
  const now = Math.floor(Date.now() / 1000)
  const attempted: DeletionOutcome['attempted'] = []
  const events: Event[] = []

  if (wrapSecret) {
    attempted.push('wrap-author')
    events.push(
      finalizeEvent(
        {
          kind: 5,
          created_at: now,
          tags: [
            ['e', giftwrapId],
            ['k', String(KIND_GIFTWRAP)],
          ],
          content: '',
        },
        hexToBytes(wrapSecret),
      ),
    )
  }

  attempted.push('recipient')
  events.push(
    await withSignerTimeout('signEvent', () =>
      active.signEvent({
        kind: 5,
        created_at: now,
        tags: [
          ['e', giftwrapId],
          ['k', String(KIND_GIFTWRAP)],
        ],
        content: '',
      }),
    ),
  )

  // Same DM relays that hold the mail. The durable outbox re-delivers to any
  // relay that doesn't accept immediately — including the local relay itself,
  // which processes the wrap-author deletion against its own store.
  const relays = await fetchDmRelays(pubkey)
  const relay = getLocalRelay()
  const results = await Promise.all(events.map((e) => relay.publish(e, { relays })))
  const anyAccepted = results.some((outcomes) => outcomes.some((o) => o.status === 'accepted'))
  return { attempted, anyAccepted }
}
