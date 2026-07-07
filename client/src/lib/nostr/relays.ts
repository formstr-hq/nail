import { SimplePool } from 'nostr-tools'
import { KIND_DM_RELAYS, DEFAULT_RELAYS } from './constants'

const pool = new SimplePool()

export function getPool(): SimplePool {
  return pool
}

export async function fetchDmRelays(pubkey: string): Promise<string[]> {
  const events = await pool.querySync(DEFAULT_RELAYS, {
    kinds: [KIND_DM_RELAYS],
    authors: [pubkey],
    limit: 1,
  }, {})

  if (!events.length) return DEFAULT_RELAYS

  const relays = events[0].tags
    .filter((t) => t[0] === 'relay')
    .map((t) => t[1])
    .filter(Boolean) as string[]

  return relays.length ? relays : DEFAULT_RELAYS
}
