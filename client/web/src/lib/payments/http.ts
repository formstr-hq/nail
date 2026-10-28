import { apiAuthUrl, apiUrl } from '@/app/lib/api/config'
import { buildNip98Header, type Nip98Signer } from '@/lib/nip98'
import { isStoreBuild } from '@/lib/platform'

/** A non-2xx answer, carrying the backend's own explanation. */
export class ApiError extends Error {
  status: number
  /** Machine-readable reason (e.g. a 409 `price_changed`), when the backend sent one. */
  reason?: string
  constructor(status: number, message: string, reason?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason
  }
}

/** Store builds announce themselves so the backend can trip on any rail they shouldn't touch. */
function channelHeaders(): Record<string, string> {
  return isStoreBuild() ? { 'X-Pay-Channel': 'store' } : {}
}

export interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  /** Sign the request with NIP-98. */
  signer?: Nip98Signer
}

/**
 * One request to the payments API. When a signer is given, the NIP-98 header
 * covers the canonical URL (what the server sees behind a proxy) and the exact
 * body bytes that are sent.
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST')
  const bodyText = opts.body === undefined ? undefined : JSON.stringify(opts.body)
  const headers: Record<string, string> = { ...channelHeaders() }
  if (bodyText !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.signer) {
    headers.Authorization = await buildNip98Header(opts.signer, apiAuthUrl(path), method, bodyText)
  }

  const res = await fetch(apiUrl(path), { method, headers, body: bodyText })

  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    // empty or non-JSON body: fall through to the status-based message
  }
  if (!res.ok) {
    const body = (payload ?? {}) as { error?: string; reason?: string }
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.reason)
  }
  return payload as T
}
