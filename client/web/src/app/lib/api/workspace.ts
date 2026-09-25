import type { ActiveSigner } from '@formstr/signer'
import { withSignerTimeout } from '../nostr/signer'
import { apiUrl, apiAuthUrl } from './config'
import { buildNip98Header, type Nip98Signer } from '@/lib/nip98'
import { Nip98AuthError } from './addresses'

/**
 * Workspace (custom domain) management API.
 *
 * Every call is NIP-98 authenticated: the backend decides authority from the
 * signed pubkey, and only a workspace owner/admin can manage it. The client
 * never sends a pubkey — the signer provides it, so there is nothing to spoof.
 *
 * Errors carry the backend's message rather than a status code: the server
 * explains *why* (a reserved name, seats exhausted, DNS not matching), and
 * that text is what the user needs to see.
 */

export interface DomainDnsRecord {
  name: string
  type: string
  value: string
  priority?: number
}

export interface DomainDnsRecords {
  verify: DomainDnsRecord
  mx: DomainDnsRecord
  spf: DomainDnsRecord
  dkim: DomainDnsRecord
  dmarc: DomainDnsRecord
}

export type DomainStatus = 'pending' | 'active' | 'suspended'

export interface WorkspaceDomain {
  id: number
  domain: string
  owner_pubkey: string
  status: DomainStatus
  dns_token?: string | null
  verified_at?: string | null
  seats_total?: number
  seats_used?: number
  created_at?: string
  dns?: DomainDnsRecords
}

export interface WorkspaceMember {
  id: number
  domain_id: number
  pubkey: string
  role: 'owner' | 'admin' | 'member'
  status: 'invited' | 'active' | 'revoked'
  nip05_id?: number | null
  /** The address this member holds, e.g. `alice@acme.com`. */
  address?: string | null
  /** Local part only, when an address is held. */
  local_part?: string | null
  claimed_at?: string | null
}

export interface SeatView {
  total: number
  used: number
  available: number
}

export interface SeatPack {
  seats: number
  discountPercent: number
  pricePerSeatSats: number
  totalSats: number
}

/** Verification outcome, mirroring the backend's discriminated result. */
export type VerifyOutcome =
  | { status: 'verified' }
  | { status: 'no-token'; expected: string; found: string[] }
  | { status: 'not-found'; expected: string }
  | { status: 'error'; message: string }

function boundSigner(active: ActiveSigner): Nip98Signer {
  return {
    signEvent: (event) => withSignerTimeout('signEvent', () => active.signEvent(event)),
  }
}

/**
 * One NIP-98 request. Signs the canonical URL (what the server sees behind a
 * proxy) and fetches the public one — the two differ in dev.
 */
async function authed<T>(
  active: ActiveSigner,
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown } = { method: 'GET' },
): Promise<T> {
  const authHeader = await buildNip98Header(
    boundSigner(active),
    apiAuthUrl(path),
    init.method,
  )

  const res = await fetch(apiUrl(path), {
    method: init.method,
    headers: {
      Authorization: authHeader,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  })

  if (res.status === 401) throw new Nip98AuthError()

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Non-JSON (or empty) — fall through to the status-based error.
  }

  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`
    throw new Error(message)
  }
  return body as T
}

/** The workspaces this account owns or manages. */
export function fetchMyDomains(active: ActiveSigner): Promise<WorkspaceDomain[]> {
  return authed<{ domains: WorkspaceDomain[] }>(active, '/api/domains/mine').then(
    (r) => r.domains ?? [],
  )
}

/**
 * Register a domain. The response carries the DNS records to publish, so the
 * UI can show them immediately rather than reconstructing them.
 */
export function registerDomain(
  active: ActiveSigner,
  domain: string,
): Promise<WorkspaceDomain> {
  return authed<WorkspaceDomain>(active, '/api/domains', {
    method: 'POST',
    body: { domain },
  })
}

/** The DNS records for a domain, plus its current verification state. */
export function fetchDomainDns(
  active: ActiveSigner,
  domain: string,
): Promise<{ status: DomainStatus; verified_at: string | null; dns: DomainDnsRecords }> {
  return authed(active, `/api/domains/${encodeURIComponent(domain)}/dns`)
}

/**
 * Run DNS verification.
 *
 * The outcome is a *result*, not a failure: "not verified yet" is the normal
 * state while DNS propagates, and the caller needs the detail (which TXT
 * values were found) to be useful. So this returns the verdict rather than
 * throwing for anything except a 401 — including the 503 the backend uses to
 * mark a transient resolver failure, which the UI presents as "try again".
 */
export async function verifyDomain(
  active: ActiveSigner,
  domain: string,
): Promise<VerifyOutcome> {
  const path = `/api/domains/${encodeURIComponent(domain)}/verify`
  const authHeader = await buildNip98Header(
    boundSigner(active),
    apiAuthUrl(path),
    'POST',
  )

  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { Authorization: authHeader },
  })

  if (res.status === 401) throw new Nip98AuthError()

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Fall through to the generic outcome below.
  }

  // 503 from the verify route carries {status:'error', message} — a retryable
  // verdict. Any other non-OK status is a real error.
  if (res.status === 503 && body && typeof body === 'object' && 'status' in body) {
    return body as VerifyOutcome
  }
  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`
    throw new Error(message)
  }
  return body as VerifyOutcome
}

/** Rotate the verification token (invalidates the previous DNS record). */
export function rotateDomainToken(
  active: ActiveSigner,
  domain: string,
): Promise<{ dns: DomainDnsRecords }> {
  return authed(active, `/api/domains/${encodeURIComponent(domain)}/rotate-token`, {
    method: 'POST',
  })
}

export function fetchMembers(
  active: ActiveSigner,
  domain: string,
): Promise<{ members: WorkspaceMember[]; seats: SeatView }> {
  return authed(active, `/api/domains/${encodeURIComponent(domain)}/members`)
}

export function assignMember(
  active: ActiveSigner,
  domain: string,
  params: { pubkey: string; name: string; role?: 'member' | 'admin' },
): Promise<{ address: string; seats: SeatView }> {
  return authed(active, `/api/domains/${encodeURIComponent(domain)}/members`, {
    method: 'POST',
    body: params,
  })
}

export function revokeMember(
  active: ActiveSigner,
  domain: string,
  pubkey: string,
): Promise<{ seats: SeatView }> {
  return authed(
    active,
    `/api/domains/${encodeURIComponent(domain)}/members/${encodeURIComponent(pubkey)}`,
    { method: 'DELETE' },
  )
}

/** Seat packs and their volume discounts (public — no auth needed). */
export async function fetchSeatPacks(): Promise<SeatPack[]> {
  const res = await fetch(apiUrl('/api/workspace/seat-packs'))
  if (!res.ok) throw new Error(`Could not load seat packs (${res.status})`)
  return (await res.json()) as SeatPack[]
}

export interface SeatInvoice {
  invoice: string
  paymentHash: string
  amount: number
  seats: number
  discountPercent: number
}

/**
 * Start a seat purchase. Returns a Lightning invoice — the caller watches the
 * payment websocket on `paymentHash`, exactly as the mail purchase flow does.
 */
export function createSeatInvoice(
  active: ActiveSigner,
  domain: string,
  seats: number,
): Promise<SeatInvoice> {
  return authed<SeatInvoice>(active, '/api/workspace/generate-invoice', {
    method: 'POST',
    body: { domain, seats },
  })
}
