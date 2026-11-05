import type { FileEventStore } from '@formstr/drive-sdk'
import { getLocalRelay } from '@/app/lib/nostr/localRelay'

/**
 * The drive-sdk's store contract backed by the app's worker relay. Used for
 * share resolution.
 */
export function localRelayStore(): FileEventStore {
  const relay = getLocalRelay()
  return {
    observe(filters, handlers, options) {
      const handle = relay.observe(filters, handlers, options)
      return { unobserve: handle.unobserve }
    },
    async publishEvent(event, options) {
      const outcomes = await relay.publish(event, options)
      const accepted = outcomes
        .filter((outcome) => outcome.status === 'accepted')
        .map((outcome) => outcome.relay)
      return {
        ok: accepted.length > 0,
        accepted: accepted.length,
        total: outcomes.length,
        relayResults: outcomes.map((outcome) => ({
          relay: outcome.relay,
          status: outcome.status,
          ...(outcome.message ? { message: outcome.message } : {}),
        })),
      }
    },
    seenOn: (eventId) => relay.seenOn(eventId),
  }
}
