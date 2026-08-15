/**
 * Runtime platform checks. The client is one build served both on the web and
 * inside the native Capacitor app (Android); a few affordances differ between
 * them (e.g. a browser extension signer only exists on the web).
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
}

/** True when running inside the native Capacitor app (its WebView). */
export function isNativeApp(): boolean {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  return !!cap?.isNativePlatform?.()
}
