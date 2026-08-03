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
}

/** Where to send the request. */
export const apiUrl = (path: string) => `${config.apiBaseUrl}${path}`

/** What to sign into the NIP-98 `u` tag. */
export const apiAuthUrl = (path: string) => `${config.apiCanonicalBaseUrl}${path}`
