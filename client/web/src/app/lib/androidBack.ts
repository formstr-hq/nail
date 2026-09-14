/**
 * Install a Capacitor `App.backButton` listener that consumes the back gesture
 * inside the client SPA before it can reach the WebView.
 *
 * The client is a state-driven single-page app — all "screens" are overlay
 * modals over the inbox, no real history. The WebView's first history entry
 * is `https://localhost/` (the landing page), so the unflanged default back
 * button pops history at the root of the client and bounces the user back
 * to landing. We install this listener so the OS back button instead walks
 * the in-app stack first.
 *
 * Reaches the plugin via the runtime global `window.Capacitor.Plugins.App` so
 * the client build stays Capacitor-free (no `@capacitor/app` dependency).
 * No-op on the web.
 *
 * The handler is bound once at mount and calls `dispatch` on every press. The
 * caller decides which "screen" to pop; if the callback returns `false`, the
 * back gesture is left unhandled (which at the client root means "do
 * nothing" — Capacitor's default is to pop WebView history, but at the root
 * there's nothing to pop, so the OS treats the next press as the app-exit
 * gesture, which is the desired behavior).
 */

interface BackButtonEvent {
  canGoBack: boolean
}

interface AppPlugin {
  addListener(event: 'backButton', handler: (e: BackButtonEvent) => void): Promise<{ remove: () => Promise<void> }>
  removeAllListeners(): Promise<void>
  exitApp?(): Promise<void>
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  Plugins?: { App?: AppPlugin }
}

function nativeApp(): AppPlugin | null {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  return cap.Plugins?.App ?? null
}

/**
 * Install the back handler.
 *
 * @param dispatch Called on every back press. Must close the topmost in-app
 *                  "screen" if there is one (open modal, then reading email,
 *                  then root) and return `true`. Returning `false` at the root
 *                  asks us to exit the app: Capacitor's plugin fires the JS
 *                  event and does NOT fall through once a listener exists, so
 *                  declining here would make back a no-op forever (audit D12).
 *                  `exitApp()` is what restores "back at root leaves the app".
 * @returns A disposer that removes the listener.
 */
export async function installAndroidBackHandler(
  dispatch: () => boolean,
): Promise<() => void> {
  const app = nativeApp()
  if (!app) return () => {}

  await app.removeAllListeners()
  const handle = await app.addListener('backButton', () => {
    const handled = dispatch()
    // At the client root there is no in-app screen left to pop, and the WebView
    // history cannot be popped safely (its first entry is the landing page).
    // Exit the app instead of swallowing the gesture.
    if (!handled) void app.exitApp?.()
  })
  return () => {
    void handle.remove()
  }
}
