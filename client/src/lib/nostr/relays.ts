import { SimplePool } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { KIND_DM_RELAYS, DEFAULT_RELAYS } from './constants'

const pool = new SimplePool()

export function getPool(): SimplePool {
  return pool
}

// A kind-10050 lookup costs a fixed ~3s (querySync waits out its window even
// when it finds nothing), and the send path needs one per recipient plus one
// for the sender. Uncached, that alone put a send at ~12s and a settings save
// at ~6s of dead UI. The list is a replaceable event that rarely changes, so
// cache it for the session and let concurrent callers share one query.
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
  const events = await pool.querySync(DEFAULT_RELAYS, {
    kinds: [KIND_DM_RELAYS],
    authors: [pubkey],
    limit: 1,
  }, {})

  if (!events.length) return DEFAULT_RELAYS

  // Kind 10050 is replaceable and we query several relays with limit:1 each,
  // so querySync can return more than one version. Take the newest — picking
  // whichever relay answered first can hand back a stale list and route mail
  // to relays the recipient no longer reads.
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0]

  const relays = latest.tags
    .filter((t) => t[0] === 'relay')
    .map((t) => t[1])
    .filter(Boolean) as string[]

  return relays.length ? relays : DEFAULT_RELAYS
}

export interface PublishResult {
  /**
   * Relays that did not reject the event. Note this is weaker than "confirmed
   * stored": nostr-tools resolves optimistically, so a relay that is simply
   * unreachable also lands here (verified — `wss://127.0.0.1:9` reports ok).
   * Treat an empty `ok` as a definite failure, not a full `ok` as a guarantee.
   */
  ok: string[]
  failed: { relay: string; error: string }[]
}

/**
 * Publish an event and report what each relay did, as far as it can be known.
 *
 * SimplePool.publish returns one promise PER relay (`Promise<string>[]`), not
 * a single promise. `await Promise.all(relays.map((u) => pool.publish([u], e)))`
 * therefore awaits an array of arrays — which are not thenable, so it resolves
 * immediately and every rejection is swallowed, turning a refused delivery into
 * a silent success. Awaiting the promises themselves catches explicit refusals
 * (relay rate limits, auth requirements, invalid events).
 */
const PUBLISH_DEADLINE_MS = 5_000

export async function publishToRelays(
  relays: string[],
  event: Event,
): Promise<PublishResult> {
  const ok: string[] = []
  const failed: { relay: string; error: string }[] = []
  if (!relays.length) return { ok, failed }

  const outcomes = pool
    .publish(relays, event, { maxWait: PUBLISH_DEADLINE_MS })
    .map((p, i) =>
      p.then(
        () => {
          ok.push(relays[i])
          return true
        },
        (reason: unknown) => {
          failed.push({ relay: relays[i], error: String(reason) })
          return false
        },
      ),
    )

  // One relay accepting the event is delivery, so return on the first success
  // instead of waiting out the slowest relay — otherwise a dead relay stalls
  // the UI behind one that already took the message. Keep waiting only while
  // nothing has succeeded, and cap that too so this can never hang.
  await Promise.race([
    new Promise<void>((resolve) => {
      let remaining = outcomes.length
      for (const outcome of outcomes) {
        void outcome.then((accepted) => {
          if (accepted || --remaining === 0) resolve()
        })
      }
    }),
    new Promise<void>((resolve) => setTimeout(resolve, PUBLISH_DEADLINE_MS)),
  ])

  if (!ok.length && !failed.length) {
    return {
      ok,
      failed: relays.map((relay) => ({
        relay,
        error: `no response within ${PUBLISH_DEADLINE_MS / 1000}s`,
      })),
    }
  }

  // Snapshot: the remaining publishes keep settling in the background.
  return { ok: [...ok], failed: [...failed] }
}
