import { KIND_PROFILE } from '@protocol'
import { getPool } from './relays'
import { DEFAULT_RELAYS } from './constants'

const PROFILE_TTL_MS = 30 * 60_000
const QUERY_MAX_WAIT_MS = 2500

export interface Profile {
  /** kind-0 `display_name` or `name`, whichever is set. */
  name: string | null
  /** kind-0 `picture`, only when it is an https URL. */
  picture: string | null
}

const EMPTY: Profile = { name: null, picture: null }

type Entry = { profile: Profile; expires: number }
const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<Profile>>()

export function clearProfileCache(): void {
  cache.clear()
  inFlight.clear()
}

/**
 * kind-0 is arbitrary JSON published by the key itself, so `picture` is an
 * attacker-controlled URL. Restricting to https keeps `javascript:` and
 * `data:` out of an `<img src>`, and means a broken record degrades to
 * initials rather than to something that runs.
 */
function safePicture(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function readName(profile: { name?: unknown; display_name?: unknown }): string | null {
  if (typeof profile.display_name === 'string' && profile.display_name.trim()) {
    return profile.display_name.trim()
  }
  if (typeof profile.name === 'string' && profile.name.trim()) return profile.name.trim()
  return null
}

/**
 * The profile a pubkey publishes for itself in its kind-0 event.
 *
 * All of this is self-asserted and carries no authority: anyone may publish
 * `name: "Your Bank"` with a matching logo. It is safe to *show* — the kind-0
 * is signed, so it genuinely is what this key calls itself — but callers must
 * keep the key visible alongside it and must never present it as a verified
 * identity. Use it only where the alternative is a bare hex pubkey.
 *
 * Returns empty fields when there is no profile, nothing usable in it, or the
 * lookup is slow; every one of those means "fall back to the key itself".
 */
export async function fetchProfile(pubkey: string): Promise<Profile> {
  const cached = cache.get(pubkey)
  if (cached && cached.expires > Date.now()) return cached.profile

  const pending = inFlight.get(pubkey)
  if (pending) return pending

  const query = (async (): Promise<Profile> => {
    try {
      const events = await getPool().querySync(
        DEFAULT_RELAYS,
        { kinds: [KIND_PROFILE], authors: [pubkey], limit: 1 },
        { maxWait: QUERY_MAX_WAIT_MS },
      )
      // Kind 0 is replaceable and several relays answer, so take the newest
      // rather than whichever replied first.
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
      if (!latest) return EMPTY

      const parsed = JSON.parse(latest.content) as {
        name?: unknown
        display_name?: unknown
        picture?: unknown
      }
      return { name: readName(parsed), picture: safePicture(parsed.picture) }
    } catch {
      // Unreachable relay, or a kind 0 whose content is not valid JSON.
      return EMPTY
    }
  })()
    .then((profile) => {
      cache.set(pubkey, { profile, expires: Date.now() + PROFILE_TTL_MS })
      return profile
    })
    .finally(() => inFlight.delete(pubkey))

  inFlight.set(pubkey, query)
  return query
}

/** Just the display name. Kept for callers that never render an avatar. */
export async function fetchProfileName(pubkey: string): Promise<string | null> {
  return (await fetchProfile(pubkey)).name
}
