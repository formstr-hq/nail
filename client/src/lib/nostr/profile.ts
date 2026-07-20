import { KIND_PROFILE } from '@protocol'
import { getPool } from './relays'
import { DEFAULT_RELAYS } from './constants'

const PROFILE_TTL_MS = 30 * 60_000
const QUERY_MAX_WAIT_MS = 2500

type Entry = { name: string | null; expires: number }
const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<string | null>>()

export function clearProfileCache(): void {
  cache.clear()
  inFlight.clear()
}

/**
 * The display name a pubkey publishes for itself in its kind-0 profile.
 *
 * This is self-asserted and carries no authority: anyone may publish
 * `name: "Your Bank"`. It is safe to *show* — the kind-0 is signed, so it
 * genuinely is what this key calls itself — but callers must keep the pubkey
 * visible alongside it and must never present it as a verified address. Use
 * it only where the alternative is showing a bare hex pubkey.
 *
 * Returns null when there is no profile, no name in it, or the lookup is slow;
 * every one of those means "fall back to the key itself".
 */
export async function fetchProfileName(pubkey: string): Promise<string | null> {
  const cached = cache.get(pubkey)
  if (cached && cached.expires > Date.now()) return cached.name

  const pending = inFlight.get(pubkey)
  if (pending) return pending

  const query = (async (): Promise<string | null> => {
    try {
      const events = await getPool().querySync(
        DEFAULT_RELAYS,
        { kinds: [KIND_PROFILE], authors: [pubkey], limit: 1 },
        { maxWait: QUERY_MAX_WAIT_MS },
      )
      // Kind 0 is replaceable and several relays answer, so take the newest
      // rather than whichever replied first.
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
      if (!latest) return null

      const profile = JSON.parse(latest.content) as {
        name?: unknown
        display_name?: unknown
      }
      const name =
        typeof profile.display_name === 'string' && profile.display_name.trim()
          ? profile.display_name.trim()
          : typeof profile.name === 'string' && profile.name.trim()
            ? profile.name.trim()
            : null
      return name
    } catch {
      // Unreachable relay, or a kind 0 whose content is not valid JSON.
      return null
    }
  })()
    .then((name) => {
      cache.set(pubkey, { name, expires: Date.now() + PROFILE_TTL_MS })
      return name
    })
    .finally(() => inFlight.delete(pubkey))

  inFlight.set(pubkey, query)
  return query
}
