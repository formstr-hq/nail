import { useCallback, useEffect, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useMailStore } from '@/app/store/mail'
import { getLocalRelay, syncAccountRelays, localRelayBootError } from '@/app/lib/nostr/localRelay'
import { decodeGiftWrap } from '@/app/lib/mail/receive'
import { DecodeQueue } from '@/app/lib/mail/decodeQueue'
import { RelayBootWatchdog } from '@/app/lib/nostr/relayWatchdog'
import { isCurrentSession, sessionEpoch } from '@/app/store/sessionEpoch'
import { protocolSigner } from '@/app/lib/nostr/protocol-signer'
import { inboxFilters } from '@/app/lib/mail/inboxFilter'
import { DEFAULT_RELAYS, withHardcodedRelay } from '@/app/lib/nostr/constants'
import type { Event } from 'nostr-tools'

/**
 * What the mailbox can honestly say about itself right now.
 *
 * `decoding` is tracked separately from the phase because being subscribed is
 * not the same as having read anything: each wrap costs a signer call, and
 * behind a NIP-46 bunker that is a relay round-trip apiece. An inbox that is
 * live but still working through a backlog must not render as empty.
 */
export type InboxStatus =
  | { phase: 'connecting'; decoding: number }
  | { phase: 'live'; relays: string[]; decoding: number }
  | { phase: 'error'; message: string; decoding: number }

/** Decrypting a gift wrap costs one signer call, and with a NIP-46 bunker
 *  that is a full relay round-trip. The subscription has no `since`, so a
 *  reload replays every wrap the relays hold and would fire all of those at
 *  the signer simultaneously — enough to swamp a bunker and leave the inbox
 *  silently empty. Run a bounded number at a time instead. */
const MAX_CONCURRENT_DECRYPTS = 3

export function useInbox() {
  const { account, active } = useAccountStore()
  const addEmail = useMailStore((s) => s.addEmail)
  const [status, setStatus] = useState<InboxStatus>({ phase: 'connecting', decoding: 0 })
  // Bumped by retry() to re-run the effect after a failed connect.
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  // Account identity for the current subscription. When it changes, the
  // connecting status below is derived from it rather than written by the
  // effect, so there is no setState-in-effect cascade.
  const sessionKey = account && active ? `${account.pubkey}:${attempt}` : null
  const [statusSession, setStatusSession] = useState<string | null>(sessionKey)
  if (sessionKey !== statusSession) {
    // Reset the displayed status on account switch / retry during render.
    setStatusSession(sessionKey)
    setStatus({ phase: 'connecting', decoding: 0 })
  }

  useEffect(() => {
    if (!account || !active) return

    let alive = true
    // The decode completions below write into the mail store; if the account
    // is switched mid-flight, `resetting` clears the store and this epoch check
    // keeps a late decode from repopulating the incoming account's inbox.
    const session = sessionEpoch()

    // A dead relay worker fails SILENTLY otherwise: observe() returns a handle
    // either way, no events ever flow, and the user sees an eternally empty
    // "connecting" inbox. Browsers that can't run the worker (Safari < 15 was
    // the reported case — no classic-worker fallback in older iOS) must get a
    // real error instead. Extracted into a testable watchdog service (C2).
    const watchdog = new RelayBootWatchdog(localRelayBootError, (message) => {
      if (!alive) return
      setStatus({ phase: 'error', message, decoding: 0 })
    })
    watchdog.start()

    // The bounded decode pump, extracted into a testable service
    // (lib/mail/decodeQueue.ts). The hook only wires callbacks.
    const queue = new DecodeQueue(MAX_CONCURRENT_DECRYPTS, {
      onEmail: (email, wrapSecret) => {
        if (!alive || !isCurrentSession(session)) return
        // Stash the wrap author's key before the email itself: delete-
        // forever needs it on hand, and a crash between the two must not
        // strand the mail as undeletable.
        if (wrapSecret) useMailStore.getState().saveWrapKey(email.id, wrapSecret)
        addEmail(email)
      },
      onFailure: (event, reason) => {
        if (!alive) return
        console.warn(
          `[inbox] rejected wrap ${event.id.slice(0, 8)}: ${reason}`,
        )
      },
      onPendingChange: (pending) => {
        if (!alive) return
        setStatus((s) => ({ ...s, decoding: pending }))
      },
    })

    let cleanup: (() => void) | undefined
    try {
      // Must be inside the try: on a browser that rejects the worker outright
      // (Safari < 15) getLocalRelay() throws, and outside the try that escapes
      // the effect before the friendly error state below can render.
      const relay = getLocalRelay()
      const signer = protocolSigner(active)

      // Reactively track this account's read (10002) and DM inbox (10050) relays;
      // the worker reopens the kind-1059 stream on the DM relays as they arrive.
      // No brittle one-shot lookup blocking the critical path. The callback
      // surfaces the effective fetch set (10050, falling back to the read floor)
      // so the relay count shown in the UI tracks what we actually read from,
      // not the static default.
      const relaysHandle = syncAccountRelays(account.pubkey, (relays) => {
        if (!alive) return
        setStatus((s) => (s.phase === 'live' ? { ...s, relays } : s))
      })

      // The partitioned inbox filters (see inboxFilter.ts): tagged mail, the
      // pre-tag history, and post-tag untagged mail. The worker opens one
      // upstream REQ per filter and dedups by event id.
      const filters = inboxFilters(account.pubkey)

      // Cache replays first (persisted wraps, offline-safe), then the worker
      // syncs upstream and streams the live tail through the same callback.
      const sub = relay.observe(filters, {
        onEvent: (event: Event) => {
          if (!alive) return
          // Skip anything already decoded — otherwise every reload pays the
          // signer round-trip again for mail we have already read.
          if (useMailStore.getState().seenIds.has(event.id)) return
          // Skip deleted mail outright: a relay that ignored the kind-5 (the
          // local cache included) will keep serving the wrap; the tombstone,
          // not the decode-then-drop path, is what pays no signer round-trip.
          if (useMailStore.getState().deletedIds.has(event.id)) return
          queue.push(event, (e) => decodeGiftWrap(e, signer, account!.pubkey))
        },
      })

      cleanup = () => {
        relaysHandle.unobserve()
        sub.unobserve()
      }
      // Deferred one microtask so this transition does not run synchronously
      // in the effect body (React compiler rule); the subscription above is
      // already wired, so the status is accurate either way.
      queueMicrotask(() => {
        if (!alive) return
        setStatus({
          phase: 'live',
          relays: withHardcodedRelay(DEFAULT_RELAYS),
          decoding: queue.pending,
        })
      })
    } catch (err) {
      console.error(err)
      // Deferred like the live transition above; a constructor throw is rare
      // and the extra microtask costs nothing.
      queueMicrotask(() => {
        if (!alive) return
        setStatus({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err),
          decoding: 0,
        })
      })
    }

    return () => {
      alive = false
      watchdog.stop()
      queue.stop()
      cleanup?.()
    }
  }, [account, active, addEmail, attempt])

  return { status, retry }
}
