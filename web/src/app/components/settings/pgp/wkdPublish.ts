import { useAccountStore } from '@/app/store/account'
import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import { publishToOwnWkd } from '@/app/lib/pgp/ownWkd'

/**
 * Publish a freshly generated public key to our own WKD directory — best-effort
 * and fire-and-forget, so it never blocks or fails key generation (the key is
 * already saved by the time this runs).
 *
 * With the DUAL set both public halves go up TOGETHER as one binary blob (the
 * standard WKD multi-key form), so services that can't parse v6 take the v4
 * half and modern clients can use either.
 *
 * Only our-domain addresses, and only to OUR WKD: the backend already vouches
 * for the identity via NIP-05, so it's authoritative with no email round-trip.
 * We deliberately do NOT publish to keys.openpgp.org — that would email a
 * verification step and permanently register the address↔key link on a third
 * party. (Keyserver LOOKUP stays, as a discovery fallback for correspondents
 * who chose to publish there themselves.)
 */
export function publishOwnKey(address: string, armoredPublicKeys: string[]): void {
  const { account, active } = useAccountStore.getState()
  const domain = address.split('@')[1]?.toLowerCase()
  if (!active || !account || domain !== BRIDGE_DOMAIN.toLowerCase()) return

  void publishToOwnWkd({ address, armoredPublicKeys, active }).catch((e) =>
    console.warn('[pgp] WKD publish failed', e),
  )
}

/**
 * The same publish `publishOwnKey` fires silently after generation, but
 * awaited and surfaced — for the manual "Republish" action.
 *
 * The automatic publish is fire-and-forget by design (never block key
 * generation), but that also means a failure (a dropped request, a signer
 * timeout, a backend hiccup) is invisible: WKD just keeps serving whatever it
 * last held — silently stale — with no way to notice or recover short of
 * generating an entirely new key, which only repeats the problem. This gives
 * the user an explicit way to retry the SAME publish for the key they
 * already hold, with a visible result.
 */
export async function republishOwnKey(
  address: string,
  armoredPublicKeys: string[],
): Promise<void> {
  const { account, active } = useAccountStore.getState()
  if (!active || !account) throw new Error('Your session is locked — sign in again.')
  const domain = address.split('@')[1]?.toLowerCase()
  if (domain !== BRIDGE_DOMAIN.toLowerCase()) {
    throw new Error(`WKD publishing only applies to @${BRIDGE_DOMAIN} addresses.`)
  }
  await publishToOwnWkd({ address, armoredPublicKeys, active })
}