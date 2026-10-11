import { describe, expect, it } from 'vitest'
import { checkDnsRecords, parseMx, type DohFetcher } from './dnsCheck'
import type { DomainDnsRecords } from '@/app/lib/api/workspace'

const RECORDS: DomainDnsRecords = {
  verify: { name: '_mailstr-verify.acme.com', type: 'TXT', value: 'token-123' },
  mx: { name: 'acme.com', type: 'MX', value: 'mail.formstr.app', priority: 10 },
  spf: { name: 'acme.com', type: 'TXT', value: 'v=spf1 mx ~all' },
  dkim: { name: 'dkim._domainkey.acme.com', type: 'TXT', value: 'v=DKIM1; k=rsa; p=ABC' },
  dmarc: {
    name: '_dmarc.acme.com',
    type: 'TXT',
    value: 'v=DMARC1; p=reject; rua=mailto:postmaster@acme.com',
  },
}

/** A fake DoH transport keyed by `name|type`; missing keys resolve to []. */
function fetcher(map: Record<string, string[]>): DohFetcher {
  return async (name, type) => {
    const values = map[`${name}|${type}`]
    if (!values) return []
    return values.map((data) => ({ name, type: type === 'MX' ? 15 : 16, data }))
  }
}

const ALL_CORRECT = {
  '_mailstr-verify.acme.com|TXT': ['"token-123"'],
  'acme.com|MX': ['10 mail.formstr.app.'],
  'acme.com|TXT': ['"v=spf1 mx ~all"'],
  'dkim._domainkey.acme.com|TXT': ['"v=DKIM1; k=rsa; p=ABC"'],
  '_dmarc.acme.com|TXT': ['"v=DMARC1; p=reject; rua=mailto:postmaster@acme.com"'],
}

describe('parseMx', () => {
  it('parses priority and strips the trailing dot', () => {
    expect(parseMx('10 mail.formstr.app.')).toEqual({ priority: 10, host: 'mail.formstr.app' })
  })
  it('returns null for junk', () => {
    expect(parseMx('not-an-mx')).toBeNull()
  })
})

describe('checkDnsRecords', () => {
  it('reports ok when every record is published correctly', async () => {
    const report = await checkDnsRecords(RECORDS, fetcher(ALL_CORRECT))
    expect(report.ok).toBe(true)
    expect(report.records.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('checks the four mail records (mx, spf, dkim, dmarc), not the ownership token', async () => {
    const report = await checkDnsRecords(RECORDS, fetcher(ALL_CORRECT))
    expect(report.records.map((r) => r.key)).toEqual(['mx', 'spf', 'dkim', 'dmarc'])
  })

  it('reports a missing MX without failing the whole check', async () => {
    const withoutMx: Record<string, string[]> = { ...ALL_CORRECT }
    delete withoutMx['acme.com|MX']
    const report = await checkDnsRecords(RECORDS, fetcher(withoutMx))
    expect(report.records.find((r) => r.key === 'mx')?.status).toBe('missing')
    expect(report.ok).toBe(false)
  })

  it('flags an MX that points somewhere else', async () => {
    const report = await checkDnsRecords(
      RECORDS,
      fetcher({ ...ALL_CORRECT, 'acme.com|MX': ['10 other.example.com.'] }),
    )
    expect(report.records.find((r) => r.key === 'mx')?.status).toBe('mismatch')
  })

  it('accepts SPF that merges other senders as long as it includes mx', async () => {
    const report = await checkDnsRecords(
      RECORDS,
      fetcher({ ...ALL_CORRECT, 'acme.com|TXT': ['"v=spf1 include:mailgun.org mx ~all"'] }),
    )
    expect(report.records.find((r) => r.key === 'spf')?.status).toBe('ok')
  })

  it('flags SPF that omits mx', async () => {
    const report = await checkDnsRecords(
      RECORDS,
      fetcher({ ...ALL_CORRECT, 'acme.com|TXT': ['"v=spf1 include:other.example ~all"'] }),
    )
    expect(report.records.find((r) => r.key === 'spf')?.status).toBe('mismatch')
  })

  it('skips DKIM while the key is still a placeholder', async () => {
    const records: DomainDnsRecords = {
      ...RECORDS,
      dkim: { ...RECORDS.dkim, value: 'v=DKIM1; k=rsa; p=<generated when the domain is verified>' },
    }
    const report = await checkDnsRecords(records, fetcher(ALL_CORRECT))
    expect(report.records.find((r) => r.key === 'dkim')?.status).toBe('skip')
    expect(report.ok).toBe(true) // a not-yet-generated key is not a failure
  })

  it('flags a DMARC policy that is not enforcing', async () => {
    const report = await checkDnsRecords(
      RECORDS,
      fetcher({ ...ALL_CORRECT, '_dmarc.acme.com|TXT': ['"v=DMARC1; p=none"'] }),
    )
    expect(report.records.find((r) => r.key === 'dmarc')?.status).toBe('mismatch')
  })

  it('reports a resolver failure as error, never as a wrong record', async () => {
    const failing: DohFetcher = async () => {
      throw new Error('resolver unreachable')
    }
    const report = await checkDnsRecords(RECORDS, failing)
    expect(report.records.every((r) => r.status === 'error')).toBe(true)
    expect(report.ok).toBe(false)
  })
})
