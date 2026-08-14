const dev = import.meta.env.DEV

export const config = {
  /**
   * Where the browser actually sends the request.
   *
   * Empty in dev on purpose: requests go to a same-origin path and Vite's
   * `/api` proxy forwards them (see vite.config.ts). api.formstr.app only
   * allows a fixed set of origins and answers anything else with a 500 rather
   * than a CORS rejection, so a direct call from localhost cannot work.
   * Set VITE_API_BASE_URL to `http://localhost:5000` to hit a local backend.
   */
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? (dev ? '' : 'https://api.formstr.app'),

  /**
   * The URL the backend believes it is serving.
   *
   * NIP-98 requires the signed `u` tag to match the request URL the server
   * sees — which, behind the dev proxy, is the upstream one and not what the
   * browser typed. Signing the browser-side URL would 401 in dev only.
   */
  apiCanonicalBaseUrl: import.meta.env.VITE_API_CANONICAL_BASE_URL ?? 'https://api.formstr.app',

  /**
   * Where the marketing/signup landing lives. New addresses are bought there
   * (the tier → invoice → payment flow only exists in that app); Settings
   * deep-links to it with `?buy=1`. Same origin in production — the landing is
   * served at `/` and this mail client at `/mails` — so `/` is the default.
   * In dev the two run on separate Vite servers, so point at the landing's
   * dev port; override with VITE_LANDING_URL for any other setup.
   */
  landingUrl: import.meta.env.VITE_LANDING_URL ?? (dev ? 'http://localhost:5178' : '/'),
}

/** Where to send the request. */
export const apiUrl = (path: string) => `${config.apiBaseUrl}${path}`

/** What to sign into the NIP-98 `u` tag. */
export const apiAuthUrl = (path: string) => `${config.apiCanonicalBaseUrl}${path}`

/** Absolute URL of the landing's "buy a new address" purchase flow. */
export const buyAddressUrl = () => {
  const base = new URL(config.landingUrl, window.location.origin)
  base.searchParams.set('buy', '1')
  return base.toString()
}
