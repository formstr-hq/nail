import type { Filter } from 'nostr-tools'
import { KIND_GIFTWRAP, KIND_MAIL } from '@/app/lib/nostr/constants'

/**
 * When the bridge started stamping `["k","1301"]` on outgoing wraps
 * (`sealAndWrap`, nostr-bridge/src/protocol/mail.ts — shipped in 0f832a7).
 *
 * Load-bearing as a *partition boundary*, not as a precise deploy time: no wrap
 * created before this can carry the tag, so `until` this timestamp is the only
 * way to reach pre-tag mail (the tag cannot be backfilled — an event id commits
 * to its tags). A later actual rollout only shifts untagged wrappers into the
 * `since` query, which catches them regardless. Widen only if a deployment
 * provably tagged earlier.
 */
const TAG_ROLLOUT_SECONDS = Math.floor(Date.UTC(2026, 7, 18) / 1000) // 2026-08-18

/**
 * The standing subscription filters for the inbox.
 *
 * A Nostr filter has no negation, so "mail that is NOT tagged `#k`" cannot be
 * expressed. The set is therefore partitioned by time instead — across the tag
 * rollout, which is the point in history that separates the two regimes:
 *
 *  1. **Tagged, any age.** `#k:['1301']` is the exact mail set on every wrap the
 *     bridge produced. Kept whole (not windowed) so tagged mail is never
 *     crowded out of a relay's capped result window by DMs.
 *  2. **Pre-tag legacy.** `#p` only, `until` the rollout. Every wrap here
 *     predates the tag, so this is the complete historical mailbox and is
 *     reachable no other way.
 *  3. **Post-tag wraps.** `#p` only, `since` the rollout. A superset of (1) that
 *     also catches untagged mail from a non-conforming third-party sender. Its
 *     window is recent, so its DM volume — the thing that truncates an
 *     unbounded `#p` query — is bounded.
 *
 * (1) is deliberately redundant with (3): if a burst of post-rollout DMs fills a
 * relay's cap for (3), the tagged query still returns mail. Redundancy here is
 * cheap — `RelayCore` dedups by event id across the subscription's filters, and
 * the mail store's `seenIds` prevents any second decode.
 *
 * `openSync` opens one upstream REQ per filter, and relay caps are per-REQ, so
 * the three windows do not compete for one budget.
 */
export function inboxFilters(pubkey: string): Filter[] {
  return [
    {
      kinds: [KIND_GIFTWRAP],
      '#p': [pubkey],
      '#k': [String(KIND_MAIL)],
    } as Filter,
    {
      kinds: [KIND_GIFTWRAP],
      '#p': [pubkey],
      until: TAG_ROLLOUT_SECONDS,
    } as Filter,
    {
      kinds: [KIND_GIFTWRAP],
      '#p': [pubkey],
      since: TAG_ROLLOUT_SECONDS,
    } as Filter,
  ]
}
