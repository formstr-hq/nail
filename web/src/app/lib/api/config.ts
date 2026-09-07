// Re-export of the shared build-time config, renamed for the mail client's
// URL-signing needs. NIP-98 requires the signed `u` tag to match the request
// URL the *server* sees — which, behind the dev proxy, is the upstream one and
// not what the browser typed — so the canonical base lives here alongside
// `apiUrl` (what we fetch).
import { config as sharedConfig } from '@/lib/config'

export const config = {
  apiBaseUrl: sharedConfig.apiBaseUrl,
  apiCanonicalBaseUrl:
    import.meta.env.VITE_API_CANONICAL_BASE_URL ?? 'https://api.formstr.app',
}

/** Where to send the request. */
export const apiUrl = (path: string) => `${config.apiBaseUrl}${path}`

/** What to sign into the NIP-98 `u` tag. */
export const apiAuthUrl = (path: string) => `${config.apiCanonicalBaseUrl}${path}`
