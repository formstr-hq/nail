import type { DomainDnsRecord, DomainDnsRecords } from '@/app/lib/api/workspace'

/**
 * Client-side DNS health check for a workspace domain.
 *
 * The *ownership* gate (`_mailstr-verify` token → activate) stays server-side —
 * a client must never be able to assert a domain is verified. But "did the owner
 * publish the mail records correctly?" is advisory, so it can run in the browser
 * over DNS-over-HTTPS (DoH), comparing the published answers against the record
 * set the backend already returned (`fetchDomainDns` → `dns.{verify,mx,spf,
 * dkim,dmarc}`). No backend call, no new endpoint.
 *
 * The DoH transport is injected so the comparison logic is unit-testable without
 * a network. The default is Cloudflare's JSON resolver (CORS-enabled).
 */

export type DnsRecordKey = keyof DomainDnsRecords

export type DnsCheckStatus = 'ok' | 'missing' | 'mismatch' | 'error' | 'skip'

export interface DnsRecordCheck {
  key: DnsRecordKey
  status: DnsCheckStatus
  /** The value the backend says should be published. */
  expected: string
  /** The values actually found (normalized). */
  found: string[]
  /** Present for non-ok statuses: a line a non-technical owner can act on. */
  detail?: string
}

export interface DnsCheckReport {
  records: DnsRecordCheck[]
  /** True when every check is `ok` (or `skip`, e.g. a not-yet-generated DKIM key). */
  ok: boolean
}

export type DohType = 'TXT' | 'MX'

/** One answer from a DoH JSON response (RFC 8484 JSON shape). */
export interface DohAnswer {
  name: string
  type: number
  TTL?: number
  data: string
}

export type DohFetcher = (name: string, type: DohType) => Promise<DohAnswer[]>

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'

/** Default transport: Cloudflare's JSON DoH API (CORS-enabled, public). */
async function cloudflareDoh(name: string, type: DohType): Promise<DohAnswer[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`
  const res = await fetch(url, { headers: { accept: 'application/dns-json' } })
  if (!res.ok) throw new Error(`resolver returned ${res.status}`)
  const body = (await res.json()) as { Status?: number; Answer?: DohAnswer[] }
  // 0 = NOERROR, 3 = NXDOMAIN (a real "no such record", not an outage). Anything
  // else is a resolver problem and must not read as "your DNS is wrong".
  if (body.Status != null && body.Status !== 0 && body.Status !== 3) {
    throw new Error(`resolver error (status ${body.Status})`)
  }
  return body.Answer ?? []
}

/** DoH TXT `data` is quoted and may be split into chunks; unquote and join. */
function txtValue(data: string): string {
  return data.replace(/"\s+"/g, '').replace(/^"|"$/g, '')
}

function stripDot(s: string): string {
  return s.endsWith('.') ? s.slice(0, -1) : s
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * A record name the way most DNS providers want it typed: relative to the
 * domain, with `@` for the domain itself (`_dmarc.acme.com` → `_dmarc`,
 * `acme.com` → `@`). GoDaddy, Namecheap, Porkbun and most others append the
 * domain on their own, so typing the full name publishes it twice. A name
 * outside `domain` is returned unchanged.
 */
export function hostName(name: string, domain: string): string {
  const full = stripDot(name.trim())
  const d = norm(stripDot(domain))
  if (norm(full) === d) return '@'
  if (norm(full).endsWith(`.${d}`)) return full.slice(0, -(d.length + 1))
  return full
}

/** Where a record ends up when the full name is typed into such a provider. */
export function doubledName(name: string, domain: string): string {
  return `${stripDot(name.trim())}.${stripDot(domain.trim())}`
}

/** What to tell an owner whose record was published under the doubled name. */
export function doubledNameHint(name: string, domain: string): string {
  return `It was saved as ${doubledName(name, domain)} — your DNS provider added ${domain} to the name a second time. Change the record's Name to just ${hostName(name, domain)}.`
}

/**
 * Whether a record exists under the doubled name, the most common beginner
 * mistake. Only ever adds a hint, so a resolver failure reads as "no".
 */
export async function hasDoubledRecord(
  name: string,
  domain: string,
  type: DohType,
  fetchDoh: DohFetcher = cloudflareDoh,
): Promise<boolean> {
  try {
    return (await fetchDoh(doubledName(name, domain), type)).length > 0
  } catch {
    return false
  }
}

/** Parse an MX `data` field (`"10 mail.example.com."`) into priority + host. */
export function parseMx(data: string): { priority: number; host: string } | null {
  const m = data.trim().match(/^(\d+)\s+(\S+)$/)
  if (!m) return null
  return { priority: Number(m[1]), host: norm(stripDot(m[2])) }
}

/** SPF is "fine" when it exists and allows us via `mx` (the value we publish). */
function spfOk(value: string): boolean {
  const v = norm(value)
  return v.startsWith('v=spf1') && /(^|\s)mx(:|\s|$)/.test(v)
}

/** DMARC is "fine" when it exists and enforces a policy (we publish p=reject). */
function dmarcOk(value: string): boolean {
  const v = norm(value)
  return v.startsWith('v=dmarc1') && /(^|;)\s*p=(reject|quarantine)(;|$)/.test(v)
}

async function checkTxt(
  key: DnsRecordKey,
  record: DomainDnsRecord,
  domain: string,
  fetchDoh: DohFetcher,
  accept: (value: string) => boolean,
): Promise<DnsRecordCheck> {
  let answers: DohAnswer[]
  try {
    answers = await fetchDoh(record.name, 'TXT')
  } catch (e) {
    return { key, status: 'error', expected: record.value, found: [], detail: (e as Error).message }
  }
  const found = answers.map((a) => txtValue(a.data))
  if (found.length === 0) {
    if (await hasDoubledRecord(record.name, domain, 'TXT', fetchDoh)) {
      return { key, status: 'mismatch', expected: record.value, found, detail: doubledNameHint(record.name, domain) }
    }
    return { key, status: 'missing', expected: record.value, found, detail: 'No TXT record found.' }
  }
  if (found.some(accept)) {
    return { key, status: 'ok', expected: record.value, found }
  }
  return {
    key,
    status: 'mismatch',
    expected: record.value,
    found,
    detail: `Found a different value: ${found.join('  |  ')}`,
  }
}

async function checkMx(
  record: DomainDnsRecord,
  domain: string,
  fetchDoh: DohFetcher,
): Promise<DnsRecordCheck> {
  let answers: DohAnswer[]
  try {
    answers = await fetchDoh(record.name, 'MX')
  } catch (e) {
    return { key: 'mx', status: 'error', expected: record.value, found: [], detail: (e as Error).message }
  }
  const parsed = answers.map((a) => parseMx(a.data)).filter((p): p is NonNullable<typeof p> => p != null)
  const expectedHost = norm(stripDot(record.value))
  const match = parsed.some(
    (p) => p.host === expectedHost && (record.priority == null || p.priority === record.priority),
  )
  const found = parsed.map((p) => `${p.priority} ${p.host}`)
  if (parsed.length === 0) {
    if (await hasDoubledRecord(record.name, domain, 'MX', fetchDoh)) {
      return { key: 'mx', status: 'mismatch', expected: record.value, found, detail: doubledNameHint(record.name, domain) }
    }
    return { key: 'mx', status: 'missing', expected: record.value, found, detail: 'No MX record found.' }
  }
  if (match) return { key: 'mx', status: 'ok', expected: record.value, found }
  return {
    key: 'mx',
    status: 'mismatch',
    expected: record.value,
    found,
    detail: `Mail is delivered to a different host: ${found.join('  |  ')}`,
  }
}

async function checkDkim(
  record: DomainDnsRecord,
  domain: string,
  fetchDoh: DohFetcher,
): Promise<DnsRecordCheck> {
  // Before activation the backend has no live key, so the expected value is a
  // placeholder — nothing to compare against yet. Activation generates it.
  if (/<generated/i.test(record.value)) {
    return {
      key: 'dkim',
      status: 'skip',
      expected: record.value,
      found: [],
      detail: 'The DKIM key is generated when the domain is verified.',
    }
  }
  return checkTxt('dkim', record, domain, fetchDoh, (v) => norm(v) === norm(record.value))
}

/**
 * Check the four records that make mail work. Never throws: an unreachable
 * resolver makes the affected checks `error`, so "we could not check" never
 * reads as "your DNS is wrong".
 *
 * The ownership record (`_mailstr-verify`) is deliberately excluded: it is a
 * one-time token the server verifies to activate the domain, and the panel
 * hides it afterwards, so requiring it here would wedge the gate on an
 * already-active domain whose owner correctly cleaned the token up.
 */
export async function checkDnsRecords(
  records: DomainDnsRecords,
  fetchDoh: DohFetcher = cloudflareDoh,
): Promise<DnsCheckReport> {
  // The MX record sits on the domain itself, so its name *is* the domain.
  const domain = records.mx.name
  const checks = await Promise.all([
    checkMx(records.mx, domain, fetchDoh),
    checkTxt('spf', records.spf, domain, fetchDoh, spfOk),
    checkDkim(records.dkim, domain, fetchDoh),
    checkTxt('dmarc', records.dmarc, domain, fetchDoh, dmarcOk),
  ])
  return { records: checks, ok: checks.every((c) => c.status === 'ok' || c.status === 'skip') }
}
