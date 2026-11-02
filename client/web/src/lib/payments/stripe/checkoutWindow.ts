// Hosted Checkout lives on Stripe's own page. In the native app that opens in
// the system browser / Custom Tab (the same runtime-global plugin access as
// openLink.ts, so the web build stays Capacitor-free) and the buyer comes back
// through a deep link; in a browser it is just a new tab.

interface BrowserPlugin {
  open(options: { url: string }): Promise<void>
  close?(): Promise<void>
}
interface AppPlugin {
  addListener(
    event: 'appUrlOpen',
    handler: (e: { url: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}
interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  Plugins?: { Browser?: BrowserPlugin; App?: AppPlugin }
}

function cap(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** Where Checkout sends the buyer back to in the native app; allowlisted by the backend. */
export const NATIVE_RETURN_URL = 'com.formstr.mail://pay-return'

export async function openCheckoutPage(url: string): Promise<void> {
  const browser = cap()?.isNativePlatform?.() ? cap()?.Plugins?.Browser : undefined
  if (browser) {
    await browser.open({ url })
    return
  }
  window.open(url, '_blank', 'noopener')
}

/**
 * Call `onReturn` when the app is re-opened through the checkout deep link, and
 * close the system browser. Returns a disposer.
 */
export function onCheckoutReturn(onReturn: () => void): () => void {
  const plugins = cap()?.isNativePlatform?.() ? cap()?.Plugins : undefined
  const app = plugins?.App
  if (!app) return () => {}
  let remove: (() => Promise<void>) | undefined
  let disposed = false
  void app
    .addListener('appUrlOpen', (event) => {
      if (!event.url.startsWith(NATIVE_RETURN_URL)) return
      void plugins?.Browser?.close?.()
      onReturn()
    })
    .then((handle) => {
      if (disposed) void handle.remove()
      else remove = handle.remove
    })
  return () => {
    disposed = true
    void remove?.()
  }
}
