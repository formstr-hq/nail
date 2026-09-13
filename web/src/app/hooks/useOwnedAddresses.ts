import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { useAccountStore } from '@/app/store/account'
import { fetchOwnedAddresses, Nip98AuthError } from '@/app/lib/api/addresses'

// Module-scope, session-lifetime cache keyed by pubkey. Never populated with
// a failed attempt's result — only a successful fetch is cached — so a
// retry (remount, or explicit reload()) always gets a fresh attempt after an
// error, with no extra bookkeeping needed.
const cache = new Map<string, string[]>()

// Cross-session cache. The module cache above is empty on every fresh page
// load, so without this the sidebar's per-alias inbox list only appears once
// the API round-trip completes — a visible "pops in late". Persisting the last
// successful result lets a reload paint the aliases immediately from disk while
// a background fetch revalidates (stale-while-revalidate). Deliberately local
// and non-authoritative: it's only ever a head start, never the source of
// truth, and a fetch always overwrites it.
//
// Persisted through zustand/persist under the SAME per-pubkey keys the
// hand-rolled helpers used (`mailstr.ownedAddresses:<pubkey>`), with each
// value kept as the bare `string[]` shape so nothing is lost on upgrade.
const ADDRESSES_KEY_PREFIX = 'mailstr.ownedAddresses:'

interface OwnedAddressesPersist {
  /** All cached per-pubkey address lists, keyed by the prefixed key. */
  entries: Record<string, string[]>
}

// Read the per-pubkey legacy entries once at module load; the persist store
// merges them so the hand-rolled values upgrade in place.
function loadLegacyEntries(): Record<string, string[]> {
  const entries: Record<string, string[]> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(ADDRESSES_KEY_PREFIX)) continue
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '')
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        entries[key] = parsed
      }
    }
  } catch {
    // Blocked/absent storage — start empty.
  }
  return entries
}

const useOwnedAddressesCache = create<OwnedAddressesPersist & { write: (pubkey: string, addresses: string[]) => void; drop: (pubkey: string) => void }>()(
  persist(
    (set) => ({
      entries: loadLegacyEntries(),
      write: (pubkey, addresses) =>
        set((s) => ({
          entries: { ...s.entries, [ADDRESSES_KEY_PREFIX + pubkey]: addresses },
        })),
      drop: (pubkey) =>
        set((s) => {
          const entries = { ...s.entries }
          delete entries[ADDRESSES_KEY_PREFIX + pubkey]
          return { entries }
        }),
    }),
    {
      name: 'mailstr.ownedAddresses.index.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
    },
  ),
)


function readPersisted(pubkey: string): string[] | null {
  return useOwnedAddressesCache.getState().entries[ADDRESSES_KEY_PREFIX + pubkey] ?? null
}

const AUTH_ERROR_MESSAGE = 'Session rejected — sign in again'

/**
 * Shared refresh signal, as a store so every mounted instance of this hook is
 * subscribed and re-fetches when it bumps. A purchase completing in the
 * in-app buy modal must refresh all consumers at once (sidebar alias list,
 * Settings, composer) — a per-instance nonce can't reach the instances
 * mounted elsewhere, and a bare module variable can't notify anyone.
 */
const useOwnedAddressesRefresh = create<{ tick: number }>(() => ({ tick: 0 }))

/** Force every mounted useOwnedAddresses() instance to refetch. */
export function reloadOwnedAddresses(): void {
  useOwnedAddressesRefresh.setState((s) => ({ tick: s.tick + 1 }))
}

/**
 * Which mailstr.app nip05 addresses the signed-in account owns. Only ever
 * mounted while Settings is open (per the plan), which is what makes "fetch
 * when this hook mounts and account/active are available" equivalent to
 * "fetch only when Settings is opened" — no extra gating needed here.
 *
 * Every render is keyed off `account?.pubkey`: whenever it changes (account
 * switch, or logout dropping it to null) state is reset before this render
 * commits, so a previous account's addresses/error can never remain visible
 * under a different (or no) account — even though the module-scope cache
 * itself is never explicitly cleared. Cache entries stay correctly scoped
 * per pubkey for the life of the tab; they just aren't evicted on logout,
 * which is a memory-growth non-issue, not a staleness one.
 *
 * The reset can't wait for a `useEffect`: the account store (see
 * `store/account.ts`) updates via a plain zustand `set()`, which is
 * synchronous, so a logout/switch can produce a render where `pubkey` has
 * already changed but `addresses` (a separate `useState`) still holds the
 * previous account's array — and that render can commit/paint before any
 * effect runs. So the reset happens directly in the render body below,
 * using the "adjusting state when a prop changes" pattern: track the last
 * seen `pubkey` in state and, if it differs, call the reset setters
 * immediately — React re-renders with the corrected state before painting,
 * instead of painting the stale one first. The effect further down still
 * does its own reset for the case where `pubkey` is unchanged but `active`
 * drops to null (e.g. session invalidated without an account switch).
 */
export function useOwnedAddresses() {
  const { account, active } = useAccountStore()
  const pubkey = account?.pubkey ?? null

  const [addresses, setAddresses] = useState<string[]>(() =>
    pubkey ? cache.get(pubkey) ?? readPersisted(pubkey) ?? [] : [],
  )
  // Only truly "loading" (spinner-worthy) when we have nothing to show yet —
  // a persisted list is painted immediately and revalidated silently.
  const [loading, setLoading] = useState<boolean>(() =>
    Boolean(pubkey && active && !cache.has(pubkey) && !readPersisted(pubkey)),
  )
  const [error, setError] = useState<string | null>(null)
  // Shared refresh tick — every instance of this hook re-fetches when it bumps
  // (a purchase completed in the buy modal), which is the point of the store.
  const reloadTick = useOwnedAddressesRefresh((s) => s.tick)

  // Render-time reset: closes the gap where a synchronous account-store
  // update (e.g. logout's `set({ account: null, active: null })`) changes
  // `pubkey` mid-render while `addresses`/`error`/`loading` still reflect
  // the previous account. Must use `useState` (not a ref) for the tracked
  // previous key — writing a ref during render doesn't trigger the re-render
  // needed to actually flush the reset before paint.
  const [prevPubkey, setPrevPubkey] = useState(pubkey)
  if (prevPubkey !== pubkey) {
    setPrevPubkey(pubkey)
    setAddresses(pubkey ? cache.get(pubkey) ?? readPersisted(pubkey) ?? [] : [])
    setError(null)
    setLoading(Boolean(pubkey && active && !cache.has(pubkey) && !(pubkey && readPersisted(pubkey))))
  }

  useEffect(() => {
    let alive = true

    // No signed-in session (or signer not ready) — nothing to show, nothing
    // to fetch. Reset unconditionally so a just-logged-out (or switched-away)
    // account's addresses don't linger in state.
    if (!pubkey || !active) {
      setAddresses([])
      setError(null)
      setLoading(false)
      return
    }

    // Mount/revalidate — and re-run whenever the shared tick advances (a
    // purchase completed in the buy modal): `reloadTick` is a dependency.
    // On plain mount the session cache may already hold the list (another
    // instance fetched it); we still revalidate silently — the API is one
    // authed GET and it is the only source of truth.

    // Nothing in the session cache. Show any persisted result immediately and
    // revalidate silently; only spin when we have nothing at all to show.
    const persisted = readPersisted(pubkey)
    const hadSomething = Boolean(persisted)
    if (persisted) {
      setAddresses(persisted)
      setError(null)
      setLoading(false)
    } else {
      setAddresses([])
      setError(null)
      setLoading(true)
    }

    fetchOwnedAddresses(active)
      .then((result: string[]) => {
        // Cache regardless of whether this effect instance is still the
        // active one — the fetch succeeded for `pubkey` and that result
        // stays valid even if the user switched accounts mid-flight, so a
        // later switch back can reuse it instead of refetching.
        cache.set(pubkey, result)
        useOwnedAddressesCache.getState().write(pubkey, result)
        if (!alive) return
        setAddresses(result)
      })
      .catch((e: unknown) => {
        if (!alive) return
        // A failed *revalidation* keeps the persisted list visible rather than
        // replacing it with an error banner. Only surface the error when we had
        // nothing to show — including an explicit reload(), which clears the
        // persisted copy first so "Try again" can report a repeat failure.
        if (hadSomething) return
        if (e instanceof Nip98AuthError) setError(AUTH_ERROR_MESSAGE)
        else setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [pubkey, active, reloadTick])

  const reload = useCallback(() => {
    if (loading) return // fetch for the current pubkey is already in flight
    // Drop the session and persisted copies, so this forced retry reports an
    // error on a repeat failure instead of silently keeping a stale list, then
    // bump the shared tick: this instance's effect re-runs (reloadTick is a
    // dependency) and every other mounted instance revalidates too.
    if (pubkey) {
      cache.delete(pubkey)
      useOwnedAddressesCache.getState().drop(pubkey)
    }
    reloadOwnedAddresses()
  }, [pubkey, loading])

  return { addresses, loading, error, reload }
}