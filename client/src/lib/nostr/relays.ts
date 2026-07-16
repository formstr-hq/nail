import { SimplePool } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { KIND_DM_RELAYS, DEFAULT_RELAYS } from './constants'

const pool = new SimplePool()

export function getPool(): SimplePool {
  return pool
}

// Extract the relay URLs from a kind 10050 DM relay list event.
export function parseDmRelayTags(event: Event): string[] {
  return event.tags
    .filter((t) => t[0] === 'relay')
    .map((t) => t[1])
    .filter(Boolean) as string[]
}

export async function fetchDmRelays(pubkey: string): Promise<string[]> {
  const events = await pool.querySync(DEFAULT_RELAYS, {
    kinds: [KIND_DM_RELAYS],
    authors: [pubkey],
    limit: 1,
  }, {})

  if (!events.length) return DEFAULT_RELAYS

  const relays = parseDmRelayTags(events[0])
  return relays.length ? relays : DEFAULT_RELAYS
}
