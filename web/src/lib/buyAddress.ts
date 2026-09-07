/** Absolute URL of the landing's "buy a new address" purchase flow.
 *
 * Same origin since the merge: the landing lives at `/` in this app, and the
 * `?buy=1` query opens its wizard in purchase mode (and suppresses its own
 * returning-owner redirect so it can't bounce back here). Kept as a helper so
 * the intent key stays in one place with web/src/lib/session.ts.
 */
export function buyAddressUrl(): string {
  const base = new URL('/', window.location.origin)
  base.searchParams.set('buy', '1')
  return base.toString()
}