import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useMailStore } from '@/app/store/mail'
import { getLocalRelay, syncAccountRelays } from '@/app/lib/nostr/localRelay'
import { fetchDmRelays } from '@/app/lib/nostr/relays'
import { decodeMailMeta } from '@/app/lib/nostr/mailMeta'
import { BoundedDecodeQueue } from '@/app/lib/mail/decodeQueue'
import { KIND_MAIL_META } from '@/app/lib/nostr/constants'
import { isCurrentSession, sessionEpoch } from '@/app/store/sessionEpoch'
import type { Event, Filter } from 'nostr-tools'

/**
 * The `created_at` of the newest kind-34578 we have decoded on this device,
 * per pubkey. Sent as `since` on the replay so a mailbox with years of
 * read/archive history does not pay one signer round-trip per event on every
 * app open (audit D5). Device-local by design: it is a cache cursor, not
 * account state, and a fresh device legitimately replays everything once.
 */
const META_CURSOR_KEY = 'mailstr.mailmeta.cursor.v1'

function readCursor(pubkey: string): number | null {
  try {
    const raw = localStorage.getItem(META_CURSOR_KEY)
    if (!raw) return null
    const map = JSON.parse(raw) as Record<string, number>
    const value = map[pubkey]
    return typeof value === 'number' && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeCursor(pubkey: string, value: number): void {
  try {
    const raw = localStorage.getItem(META_CURSOR_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    map[pubkey] = value
    localStorage.setItem(META_CURSOR_KEY, JSON.stringify(map))
  } catch {
    // Storage unavailable — worst case we replay next session.
  }
}

/**
 * Keep the mail store's per-mail state in step with the kind-34578 metadata
 * events on the relays, so read/archived/trashed status follows the user across
 * devices.
 *
 * This mirrors useInbox: the local relay replays cached events first (offline
 * safe), then streams the live tail — so this one subscription covers both the
 * initial load and cross-device updates. Each event costs one signer call to
 * decrypt (behind a NIP-46 bunker, a round-trip apiece), so decrypts run through
 * the same bounded DecodeQueue as the inbox and a persisted per-account `since`
 * cursor skips already-decoded history on relaunch.
 *
 * These events live on the account's DM relays (alongside settings and gift
 * wraps), which aren't part of the general read floor, so the subscription is
 * pointed at them explicitly — otherwise it would read from relays the events
 * were never published to.
 */
export function useMailMeta() {
  const { account, active } = useAccountStore()
  // Bumped by refresh() to tear down and re-open the subscription, which kicks
  // off a fresh upstream sync — the app's only "reload" affordance.
  const [attempt, setAttempt] = useState(0)
  const refresh = useCallback(() => setAttempt((n) => n + 1), [])
  // Highest created_at decoded this mount, so the cursor advances even before
  // the effect tears down.
  const newestSeen = useRef(0)

  useEffect(() => {
    if (!account || !active) return

    let alive = true
    // In-flight metadata decodes write into the mail store; if the account is
    // switched mid-flight the store is cleared, and this epoch check keeps a
    // late result out of the incoming account's state.
    const session = sessionEpoch()
    const pubkey = account.pubkey
    const signer = active
    newestSeen.current = readCursor(pubkey) ?? 0

    // getLocalRelay() can throw on a browser that rejects the worker (Safari
    // < 15), same as useInbox (audit D6). Metadata sync failing must not crash
    // the app — log and skip this subscription.
    let relay: ReturnType<typeof getLocalRelay>
    try {
      relay = getLocalRelay()
    } catch (err) {
      console.warn('[mailmeta] relay worker unavailable; mail state will not sync', err)
      return
    }

      const queue = new BoundedDecodeQueue<{ ref: string; flags: import('@/app/types/mail').MailFlags }>(
      3,
      {
        onResult: (entry) => {
          // A decode that straddles a logout/switch must not write the old
          // account's flags into the freshly cleared store.
          if (!alive || !isCurrentSession(session)) return
          useMailStore.getState().hydrateFlags([{ ref: entry.ref, flags: entry.flags }])
        },
        onFailure: (event, reason) => {
          if (import.meta.env.DEV) {
            console.warn(`[mailmeta] could not decode ${event.id.slice(0, 8)}: ${reason}`)
          }
        },
        onPendingChange: () => {
          // No UI surface for metadata backlog yet.
        },
      },
    )

    const onEvent = (event: Event) => {
      if (!alive) return
      // A relay (or the local cache) can replay an event we already hold.
      // Skip by id first so no signer round-trip is paid for a duplicate.
      if (useMailStore.getState().seenMetaIds.has(event.id)) return
      // Strictly older than the cursor: decoded in a previous session. Events
      // at exactly the cursor are re-fetched (since is inclusive) so a second
      // state event published in that same second — a sibling mail's update —
      // is not missed; re-decoding the boundary event is at most 1–2 extra
      // signer calls per session.
      if (event.created_at < newestSeen.current) return
      queue.push(event, async (e) => {
        let entry: Awaited<ReturnType<typeof decodeMailMeta>>
        try {
          entry = await decodeMailMeta(e, pubkey, signer)
        } catch {
          // Signer failure (timeout / bunker unreachable): the same event may
          // decode on a retry, so do NOT mark it seen and let the queue retry.
          return {
            failure: { routine: false, retryable: true, reason: 'signer-error' },
          }
        }
        // Marked seen: an undecryptable event is not ours to retry, and
        // retrying would only spend another signer call.
        useMailStore.getState().markMetaSeen(e.id)
        if (!entry) {
          return { failure: { routine: true, reason: 'not-ours' } }
        }
        if (e.created_at > newestSeen.current) {
          newestSeen.current = e.created_at
          writeCursor(pubkey, e.created_at)
        }
        return { value: { ref: entry.ref, flags: entry.flags } }
      })
    }

    // Keep the worker's routing lists warm for this account (same as useInbox).
    const relaysHandle = syncAccountRelays(pubkey)

    let sub: { unobserve: () => void } | undefined
    void (async () => {
      const relays = await fetchDmRelays(pubkey)
      if (!alive) return
      const cursor = readCursor(pubkey)
      const filter: Filter = {
        kinds: [KIND_MAIL_META],
        authors: [pubkey],
        // Inclusive on the cursor; the onEvent guard is `<` so the boundary
        // second's events are re-checked (see the comment there).
        ...(cursor ? { since: cursor } : {}),
      }
      sub = relay.observe([filter], { onEvent }, { relays })
    })()

    return () => {
      alive = false
      queue.stop()
      relaysHandle.unobserve()
      sub?.unobserve()
    }
  }, [account, active, attempt])

  return { refresh }
}
