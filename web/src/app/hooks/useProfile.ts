import { useEffect, useState } from 'react'
import { fetchProfile, type Profile } from '@/app/lib/nostr/profile'

const EMPTY: Profile = { name: null, picture: null }

/**
 * The kind-0 profile for a pubkey, resolved in the background.
 *
 * Starts empty and fills in when the relays answer, so callers render their
 * fallback first and never block on a lookup that may simply never resolve.
 */
export function useProfile(pubkey: string | null | undefined): Profile {
  // Track which pubkey the fetched profile belongs to, so a key switch can
  // never render the previous sender's name while the new lookup is in flight.
  const [loaded, setLoaded] = useState<{ pubkey: string; profile: Profile } | null>(null)

  useEffect(() => {
    if (!pubkey) return
    let alive = true
    fetchProfile(pubkey)
      .then((p) => {
        if (alive) setLoaded({ pubkey, profile: p })
      })
      .catch(() => {
        /* fetchProfile already degrades to empty; nothing to add here. */
      })
    return () => {
      alive = false
    }
  }, [pubkey])

  return pubkey && loaded?.pubkey === pubkey ? loaded.profile : EMPTY
}
