import { queryLocal } from './localRelay'
import { KIND_DM_RELAYS, DEFAULT_RELAYS } from './constants'

// A kind-10050 lookup goes through the local relay worker (author-scoped, so it
// routes to the author's outbox ∪ the default read set) and the send path needs
// one per recipient plus one for the sender. The list is a replaceable event
// that rarely changes, so cache it for the session and let concurrent callers
// share one query.
const DM_RELAY_TTL_MS = 5 * 60_000
const dmRelayCache = new Map<string, { relays: string[]; expires: number }>()
const dmRelayInFlight = new Map<string, Promise<string[]>>()

export function clearDmRelayCache(pubkey?: string): void {
  if (pubkey) dmRelayCache.delete(pubkey)
  else dmRelayCache.clear()
}

export async function fetchDmRelays(pubkey: string): Promise<string[]> {
  const cached = dmRelayCache.get(pubkey)
  if (cached && cached.expires > Date.now()) return cached.relays

  const pending = dmRelayInFlight.get(pubkey)
  if (pending) return pending

  const query = queryDmRelays(pubkey)
    .then((relays) => {
      dmRelayCache.set(pubkey, { relays, expires: Date.now() + DM_RELAY_TTL_MS })
      return relays
    })
    .finally(() => dmRelayInFlight.delete(pubkey))

  dmRelayInFlight.set(pubkey, query)
  return query
}

async function queryDmRelays(pubkey: string): Promise<string[]> {
  const events = await queryLocal([
    { kinds: [KIND_DM_RELAYS], authors: [pubkey], limit: 1 },
  ])

  if (!events.length) return DEFAULT_RELAYS

  // Kind 10050 is replaceable and the worker may hold more than one version;
  // take the newest — a stale list routes mail to relays the recipient no longer
  // reads.
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0]

  const relays = latest.tags
    .filter((t) => t[0] === 'relay')
    .map((t) => t[1])
    .filter(Boolean) as string[]

  return relays.length ? relays : DEFAULT_RELAYS
}
