import { LocalRelayClient, workerChannel } from '@formstr/local-relay'
import type { Event, Filter } from 'nostr-tools'
import { useAccountStore } from '@/store/account'
import { DEFAULT_RELAYS, KIND_DM_RELAYS, KIND_NIP65_RELAYS, withHardcodedRelay } from './constants'

/**
 * The session's single worker-backed local relay.
 *
 * The worker owns a NIP-01 event store persisted to IndexedDB and every
 * connection decision; the app only DECLARES INTERESTS (`observe`) and reads
 * back. Two properties are why the mailbox uses it instead of a bare
 * SimplePool:
 *
 *  - Persistence. Gift-wrap ciphertext (kind 1059) is cached locally, so a
 *    reload replays the mailbox from disk before any relay answers — mail you
 *    have already received can't vanish because a relay expired or dropped it.
 *  - Honest completion. Its pool only reports EOSE once every targeted relay
 *    has answered (or a deadline elapses), where SimplePool fires on the first
 *    relay's EOSE — which routinely reports "done" while most relays are still
 *    streaming, silently losing events.
 */
let client: LocalRelayClient | null = null

export function getLocalRelay(): LocalRelayClient {
  if (client) return client
  // Spawn our own worker entry (see relay.worker.ts) rather than the package's
  // prebuilt `/worker` subpath: a bare-specifier worker URL resolves under
  // `vite build` but not `vite dev`, which left the worker never running.
  const worker = new Worker(new URL('./relay.worker.ts', import.meta.url), {
    type: 'module',
  })
  client = new LocalRelayClient(workerChannel(worker), {
    // The worker asks us to sign NIP-42 AUTH challenges. DM relays routinely
    // require AUTH before they will serve kind-1059 gift wraps (it protects the
    // recipient's metadata), so without this the relay refuses and the mailbox
    // stays empty. Route the challenge to the active signer.
    onSignRequest: async (template) => {
      const active = useAccountStore.getState().active
      if (!active) return null
      try {
        return (await active.signEvent(template)) as Event
      } catch {
        // Refuse → the worker treats the relay as auth-failed (counts as done)
        // rather than hanging the subscription.
        return null
      }
    },
  })
  // A fallback read set until the account's own NIP-17 inbox relays (kind
  // 10050) are known; the kind-1059 DM stream is routed to those specifically.
  // Union in the hardcoded reliability relay so the read floor always includes
  // relay.primal.net even before the account's own lists are known.
  client.setUserRelays(withHardcodedRelay(DEFAULT_RELAYS))
  return client
}

/**
 * Keep the worker's routing relays in step with an account's own relay lists,
 * applying each as it arrives (from cache or upstream) rather than through a
 * brittle one-shot lookup on the critical path:
 *
 *  - kind 10002 (NIP-65) → `setUserRelays` (the read floor for feeds/DMs)
 *  - kind 10050 (NIP-17) → `setDmRelays` (where the kind-1059 stream reads)
 *
 * A real change to either reopens the affected standing subscriptions on the new
 * set, so the mailbox starts reading from the account's actual DM inbox relays as
 * soon as its 10050 is known — no timeout can cut that off. Returns the standing
 * interest's handle so the caller can drop it on teardown.
 *
 * `onRelays` reports the effective relay set the kind-1059 DM stream reads from,
 * mirroring the worker's `dmReadRelays()` rule: the account's NIP-17 inbox
 * (10050) relays once any are known, falling back to the read floor (10002 ∪
 * defaults) until then. Fired on every change so a UI can show the count the
 * mailbox is actually fetching from, not a static default.
 */
export function syncAccountRelays(
  pubkey: string,
  onRelays?: (relays: string[]) => void,
): { unobserve: () => void } {
  const relay = getLocalRelay()
  relay.setActiveAccount(pubkey)

  const readRelays = new Set(withHardcodedRelay(DEFAULT_RELAYS))
  const dmRelays = new Set<string>()

  const report = () => {
    if (!onRelays) return
    // DM stream targets the 10050 set; until one is known it falls back to the
    // read floor so mail still arrives. Match the worker's dmReadRelays() rule.
    // Either way the hardcoded reliability relay (relay.primal.net) is in the
    // reported set, matching what the worker actually reads from.
    onRelays(
      withHardcodedRelay(dmRelays.size ? [...dmRelays] : [...readRelays]),
    )
  }

  return relay.observe(
    [{ kinds: [KIND_NIP65_RELAYS, KIND_DM_RELAYS], authors: [pubkey] }],
    {
      onEvent: (event: Event) => {
        if (event.kind === KIND_DM_RELAYS) {
          for (const t of event.tags) if (t[0] === 'relay' && t[1]) dmRelays.add(t[1])
          relay.setDmRelays(withHardcodedRelay([...dmRelays]))
        } else {
          // NIP-65 `r` tags: unmarked = read+write, "read" = an inbox relay.
          for (const t of event.tags) {
            if (t[0] === 'r' && t[1] && (!t[2] || t[2] === 'read')) readRelays.add(t[1])
          }
          relay.setUserRelays(withHardcodedRelay([...readRelays]))
        }
        report()
      },
    },
  )
}

/**
 * A one-shot read through the worker.
 *
 * The worker's EOSE is NOT the signal to resolve on: a REQ replays the cache,
 * EOSEs immediately, then streams the *upstream* results afterwards as live
 * events with no second EOSE. Resolving on that EOSE would return only what was
 * already cached — nothing on a cold store. So instead we collect events and
 * resolve once they stop arriving (a brief quiet period after the last one), or
 * at a hard deadline — whichever comes first. Cold-with-no-result resolves empty
 * at the deadline.
 *
 * `relays` are read-relay hints folded into routing — needed when the data isn't
 * on the worker's default read set (e.g. a replaceable event that lives on the
 * user's DM relays). The worker persists whatever it fetches, so a repeat read
 * is served from cache and settles fast.
 */
export function queryLocal(
  filters: Filter[],
  opts: { relays?: string[]; timeoutMs?: number; settleMs?: number } = {},
): Promise<Event[]> {
  const relay = getLocalRelay()
  const { relays, timeoutMs = 4000, settleMs = 600 } = opts
  return new Promise((resolve) => {
    const events: Event[] = []
    let settled = false
    let handle: { unobserve: () => void } | null = null
    let quiet: ReturnType<typeof setTimeout> | null = null

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(hard)
      if (quiet) clearTimeout(quiet)
      handle?.unobserve()
      resolve(events)
    }

    const hard = setTimeout(finish, timeoutMs)
    handle = relay.observe(
      filters,
      {
        onEvent: (e) => {
          events.push(e)
          // Restart the quiet timer on each event so a burst (e.g. several
          // relays answering, or an old + newer replaceable version) is fully
          // collected before we resolve.
          if (quiet) clearTimeout(quiet)
          quiet = setTimeout(finish, settleMs)
        },
      },
      relays ? { relays } : undefined,
    )
  })
}
