import type { ActiveSigner } from '@formstr/signer'
import { queryLocal, getLocalRelay } from './localRelay'
import { withSignerTimeout } from './signer'
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

/**
 * The account's kind-10050 relays *and whether an explicit list exists*.
 *
 * `fetchDmRelays` collapses "user has no list" into `DEFAULT_RELAYS`, which is
 * right for routing but wrong for onboarding — the relay screen needs to tell
 * "these are your relays, confirm them" from "you have none yet, here's a
 * default set to accept". `hasList` carries that distinction; `relays` is the
 * user's own list when present, else the defaults (a sensible pre-fill).
 */
export async function fetchDmRelayList(
  pubkey: string,
): Promise<{ relays: string[]; hasList: boolean }> {
  const events = await queryLocal([
    { kinds: [KIND_DM_RELAYS], authors: [pubkey], limit: 1 },
  ])

  if (!events.length) return { relays: DEFAULT_RELAYS, hasList: false }

  const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
  const relays = latest.tags
    .filter((t) => t[0] === 'relay')
    .map((t) => t[1])
    .filter(Boolean) as string[]

  return relays.length
    ? { relays, hasList: true }
    : { relays: DEFAULT_RELAYS, hasList: false }
}

/**
 * Publish the account's kind-10050 (NIP-17 DM/inbox) relay list.
 *
 * The event is broadcast to the new set itself plus the defaults, so other
 * clients (and our own next cold start) can still discover it even if every
 * relay in the new set is unfamiliar. The session cache is cleared so the next
 * `fetchDmRelays`/`fetchDmRelayList` reflects the change instead of a stale TTL.
 */
export async function publishDmRelays(
  relays: string[],
  pubkey: string,
  active: ActiveSigner,
): Promise<void> {
  const clean = [...new Set(relays.map((r) => r.trim()).filter(Boolean))]
  if (!clean.length) throw new Error('Add at least one relay')

  const event = await withSignerTimeout('signEvent', () =>
    active.signEvent({
      kind: KIND_DM_RELAYS,
      created_at: Math.floor(Date.now() / 1000),
      tags: clean.map((url) => ['relay', url]),
      content: '',
    }),
  )

  const targets = [...new Set([...clean, ...DEFAULT_RELAYS])]
  const outcomes = await getLocalRelay().publish(event, { relays: targets })
  const accepted = outcomes.filter((o) => o.status === 'accepted')

  if (!accepted.length) {
    const reason = outcomes.find((o) => o.message)?.message ?? 'no relay accepted the event'
    throw new Error(`Could not save relays: ${reason}`)
  }

  clearDmRelayCache(pubkey)
}
