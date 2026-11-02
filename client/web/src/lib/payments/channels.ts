import type { MethodId } from './types'

/**
 * Which method the sheet opens on: the buyer's remembered choice if it is
 * still offered, otherwise the first method in the build's own order.
 */
export function pickDefaultMethod(offered: readonly MethodId[], remembered: MethodId | null): MethodId | null {
  if (remembered && offered.includes(remembered)) return remembered
  return offered[0] ?? null
}

/**
 * Checkout inside the Capacitor WebView origin is unverified, so the native app
 * uses Stripe's hosted page (opened in a browser tab) and resumes by polling;
 * the browser embeds Checkout.
 */
export function checkoutUiMode(native: boolean): 'embedded' | 'hosted' {
  return native ? 'hosted' : 'embedded'
}
