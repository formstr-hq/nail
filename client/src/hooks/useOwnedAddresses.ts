import { useCallback, useEffect, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { fetchOwnedAddresses, Nip98AuthError } from '@/lib/api/addresses'

// Module-scope, session-lifetime cache keyed by pubkey. Never populated with
// a failed attempt's result — only a successful fetch is cached — so a
// retry (remount, or explicit reload()) always gets a fresh attempt after an
// error, with no extra bookkeeping needed.
const cache = new Map<string, string[]>()

const AUTH_ERROR_MESSAGE = 'Session rejected — sign in again'

/**
 * Which mailstr.app nip05 addresses the signed-in account owns. Only ever
 * mounted while Settings is open (per the plan), which is what makes "fetch
 * when this hook mounts and account/active are available" equivalent to
 * "fetch only when Settings is opened" — no extra gating needed here.
 *
 * Every render is keyed off `account?.pubkey`: whenever it changes (account
 * switch, or logout dropping it to null) the effect below resets state
 * before doing anything else, so a previous account's addresses/error can
 * never remain visible under a different (or no) account — even though the
 * module-scope cache itself is never explicitly cleared. Cache entries stay
 * correctly scoped per pubkey for the life of the tab; they just aren't
 * evicted on logout, which is a memory-growth non-issue, not a staleness one.
 */
export function useOwnedAddresses() {
  const { account, active } = useAccountStore()
  const pubkey = account?.pubkey ?? null

  const [addresses, setAddresses] = useState<string[]>(() =>
    pubkey ? cache.get(pubkey) ?? [] : [],
  )
  const [loading, setLoading] = useState<boolean>(() => Boolean(pubkey && active && !cache.has(pubkey)))
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

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

    const cached = cache.get(pubkey)
    if (cached) {
      setAddresses(cached)
      setError(null)
      setLoading(false)
      return
    }

    setAddresses([])
    setError(null)
    setLoading(true)

    fetchOwnedAddresses(active)
      .then((result) => {
        // Cache regardless of whether this effect instance is still the
        // active one — the fetch succeeded for `pubkey` and that result
        // stays valid even if the user switched accounts mid-flight, so a
        // later switch back can reuse it instead of refetching.
        cache.set(pubkey, result)
        if (!alive) return
        setAddresses(result)
      })
      .catch((e) => {
        if (!alive) return
        if (e instanceof Nip98AuthError) setError(AUTH_ERROR_MESSAGE)
        else setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [pubkey, active, reloadNonce])

  const reload = useCallback(() => {
    if (pubkey) cache.delete(pubkey)
    setReloadNonce((n) => n + 1)
  }, [pubkey])

  return { addresses, loading, error, reload }
}
