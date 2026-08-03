import { useEffect, useState } from 'react'
import { fetchProfile, type Profile } from '@/lib/nostr/profile'

const EMPTY: Profile = { name: null, picture: null }

/**
 * The kind-0 profile for a pubkey, resolved in the background.
 *
 * Starts empty and fills in when the relays answer, so callers render their
 * fallback first and never block on a lookup that may simply never resolve.
 */
export function useProfile(pubkey: string | null | undefined): Profile {
  const [profile, setProfile] = useState<Profile>(EMPTY)

  useEffect(() => {
    if (!pubkey) {
      setProfile(EMPTY)
      return
    }
    let alive = true
    // Reset first: without this, switching to a key with no profile would keep
    // showing the previous sender's name and picture.
    setProfile(EMPTY)
    fetchProfile(pubkey)
      .then((p) => {
        if (alive) setProfile(p)
      })
      .catch(() => {
        /* fetchProfile already degrades to empty; nothing to add here. */
      })
    return () => {
      alive = false
    }
  }, [pubkey])

  return profile
}
