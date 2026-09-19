import { useAccountStore } from '@/app/store/account'
import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import { publishToOwnWkd } from '@/app/lib/pgp/ownWkd'

/**
 * Publish one of our own public keys to our own WKD directory, awaited and
 * surfaced.
 *
 * Used by `lib/pgp/install.ts` for BOTH first-time generation and rotation —
 * deliberately NOT fire-and-forget: a WKD publish is part of installing a key,
 * and the install treats a publish failure as the whole operation failing (the
 * save is rolled back), because a stored-but-unpublished key makes no sense for
 * a brand-new alias. The user sees the failure via the install error.
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