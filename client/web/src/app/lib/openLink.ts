/**
 * Open a link found inside a mail body, in whichever browser the platform has.
 *
 * Two environments, two mechanisms:
 *
 *  - Web: do nothing and let the browser handle the anchor's own click. The
 *    frame's `<base target="_blank">` already sends it to a new tab; taking
 *    over here would only fight the popup blocker.
 *  - Native (Capacitor): the app's WebView has no popup support at all —
 *    Capacitor never enables multiple windows nor implements
 *    `onCreateWindow`, so `target="_blank"` (and `window.open`) is a silent
 *    no-op and the link appears dead. There, hand the URL to the
 *    `@capacitor/browser` plugin, which opens the system browser / Custom
 *    Tab. The same runtime-global access pattern as androidBack.ts and
 *    notifications.ts keeps the web build Capacitor-free.
 *
 * Only `http`/`https` are ever handed out. A mail body is attacker-controlled
 * input, and schemes like `tel:`, `intent:`, or `mailto:` can launch foreign
 * apps (or, with `intent:`, arbitrary Android components) from a single tap.
 */

/** Capacitor's Browser plugin surface — just the method used here. */
interface BrowserPlugin {
  open(options: { url: string }): Promise<void>
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  Plugins?: { Browser?: BrowserPlugin }
}

/** True when `href` parses as an absolute http(s) URL. */
export function isSafeExternalUrl(href: string): boolean {
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Send `href` to the platform's browser. Returns true when the link was
 * handled here (native) and the caller should `preventDefault()`; false on
 * the web or for a rejected URL, where the default browser behavior (or
 * nothing) is correct.
 */
export function openExternal(href: string): boolean {
  if (!isSafeExternalUrl(href)) return false

  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap?.isNativePlatform?.()) return false // web: let the browser open its own tab

  const browser = cap.Plugins?.Browser
  if (!browser) return false
  void browser.open({ url: href })
  return true
}
