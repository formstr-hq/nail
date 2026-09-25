import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchMyDomains,
  registerDomain,
  fetchDomainDns,
  verifyDomain,
  assignMember,
  revokeMember,
  createSeatInvoice,
  fetchSeatPacks,
} from './workspace'

/**
 * The workspace API client. These tests pin the two things that break silently:
 * the request shape (method, path, NIP-98 header) and how a failure surfaces
 * (the server's message, not a bare status).
 */

// A signer stub: buildNip98Header only needs signEvent to return an event.
const active = {
  pubkey: 'a'.repeat(64),
  signEvent: vi.fn(async (event: Record<string, unknown>) => ({
    ...event,
    pubkey: 'a'.repeat(64),
    id: 'f'.repeat(64),
    sig: '0'.repeat(128),
  })),
} as never

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init)),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('fetchMyDomains', () => {
  it('returns the domains array', async () => {
    mockFetch(() => json({ domains: [{ domain: 'acme.com', status: 'active' }] }))
    const domains = await fetchMyDomains(active)
    expect(domains).toHaveLength(1)
    expect(domains[0].domain).toBe('acme.com')
  })

  it('tolerates a missing domains field', async () => {
    mockFetch(() => json({}))
    await expect(fetchMyDomains(active)).resolves.toEqual([])
  })

  // 401 means the session, not the request, is the problem — callers branch on
  // the error type to offer "sign in again".
  it('throws Nip98AuthError on 401', async () => {
    mockFetch(() => json({ error: 'Unauthorized' }, 401))
    await expect(fetchMyDomains(active)).rejects.toMatchObject({
      name: 'Nip98AuthError',
    })
  })
})

describe('registerDomain', () => {
  it('POSTs the domain', async () => {
    const spy = mockFetch(() => json({ domain: 'acme.com', status: 'pending' }, 201))
    await registerDomain(active, 'acme.com')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('/api/domains')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ domain: 'acme.com' })
  })

  it("surfaces the server's message on failure", async () => {
    mockFetch(() => json({ error: 'Domain is already registered' }, 409))
    await expect(registerDomain(active, 'acme.com')).rejects.toThrow(
      'Domain is already registered',
    )
  })
})

describe('fetchDomainDns', () => {
  it('requests the domain-scoped DNS endpoint', async () => {
    const spy = mockFetch(() => json({ status: 'pending', verified_at: null, dns: {} }))
    await fetchDomainDns(active, 'acme.com')
    expect(String(spy.mock.calls[0][0])).toContain('/api/domains/acme.com/dns')
  })

  it('encodes a domain with unusual characters', async () => {
    const spy = mockFetch(() => json({ status: 'pending', verified_at: null, dns: {} }))
    await fetchDomainDns(active, 'a b.com')
    expect(String(spy.mock.calls[0][0])).toContain(encodeURIComponent('a b.com'))
  })
})

describe('verifyDomain', () => {
  it('POSTs to the verify endpoint and returns the outcome', async () => {
    const spy = mockFetch(() => json({ status: 'verified' }))
    const outcome = await verifyDomain(active, 'acme.com')
    expect(outcome).toEqual({ status: 'verified' })
    expect(String(spy.mock.calls[0][0])).toContain('/verify')
    expect(spy.mock.calls[0][1]?.method).toBe('POST')
  })

  // A resolver outage is 503; the UI must present it as retryable, so the
  // thrown message has to reach the caller rather than being swallowed.
  it('surfaces a transient failure as an error', async () => {
    mockFetch(() => json({ status: 'error', message: 'dns timeout' }, 503))
    await expect(verifyDomain(active, 'acme.com')).resolves.toEqual({
      status: 'error',
      message: 'dns timeout',
    })
  })
})

describe('assignMember', () => {
  it('posts the pubkey and name', async () => {
    const spy = mockFetch(() =>
      json({ address: 'alice@acme.com', seats: { total: 5, used: 1, available: 4 } }, 201),
    )
    const res = await assignMember(active, 'acme.com', {
      pubkey: 'b'.repeat(64),
      name: 'alice',
    })
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({
      pubkey: 'b'.repeat(64),
      name: 'alice',
    })
    expect(res.address).toBe('alice@acme.com')
  })

  // Seats exhausted is a distinct product state — the message must survive so
  // the UI can offer "buy more seats" rather than a generic failure.
  it('surfaces the seats-exhausted message', async () => {
    mockFetch(() => json({ error: 'No seats available', code: 'seats_exhausted' }, 402))
    await expect(
      assignMember(active, 'acme.com', { pubkey: 'b'.repeat(64), name: 'alice' }),
    ).rejects.toThrow('No seats available')
  })
})

describe('revokeMember', () => {
  it('DELETEs the member path with the pubkey encoded', async () => {
    const spy = mockFetch(() => json({ seats: { total: 5, used: 0, available: 5 } }))
    await revokeMember(active, 'acme.com', 'b'.repeat(64))
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain(`/api/domains/acme.com/members/${'b'.repeat(64)}`)
    expect(init?.method).toBe('DELETE')
  })
})

describe('createSeatInvoice', () => {
  it('posts the domain and seat count', async () => {
    const spy = mockFetch(() =>
      json({ invoice: 'lnbc1...', paymentHash: 'h', amount: 180, seats: 10, discountPercent: 10 }),
    )
    const res = await createSeatInvoice(active, 'acme.com', 10)
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({
      domain: 'acme.com',
      seats: 10,
    })
    expect(res.amount).toBe(180)
  })
})

describe('fetchSeatPacks', () => {
  it('is unauthenticated and returns the packs', async () => {
    const spy = mockFetch(() =>
      json([{ seats: 1, discountPercent: 0, pricePerSeatSats: 20, totalSats: 20 }]),
    )
    const packs = await fetchSeatPacks()
    expect(packs).toHaveLength(1)
    // No Authorization header: this endpoint is public.
    expect(spy.mock.calls[0][1]).toBeUndefined()
  })

  it('reports a failure rather than an empty list', async () => {
    mockFetch(() => json({}, 500))
    await expect(fetchSeatPacks()).rejects.toThrow(/500/)
  })
})
