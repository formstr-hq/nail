import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSeatInvoice, fetchSeatPricing, generateMailInvoice, orderSats, tierSats } from './api'
import { normalizeTier } from '@/lib/api'

const signer = {
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

function mockFetch(body: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('lightning api', () => {
  it('requests a mail invoice with a signed body', async () => {
    const spy = mockFetch({ invoice: 'lnbc1', paymentHash: 'h', amount: 1000 })
    const inv = await generateMailInvoice(signer, { pubkey: 'p', nip05: 'a@b', tierId: 'base' })
    expect(inv.amount).toBe(1000)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/generate-invoice/mail')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ pubkey: 'p', nip05: 'a@b', tierId: 'base' })
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Nostr /)
  })

  it('requests a seat invoice for the domain and count', async () => {
    const spy = mockFetch({ invoice: 'x', paymentHash: 'h', amount: 900, seats: 10, pricePerSeatSats: 90 })
    const inv = await createSeatInvoice(signer, 'acme.com', 10)
    expect(inv.pricePerSeatSats).toBe(90)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/workspace/generate-invoice')
    expect(JSON.parse(String(init.body))).toEqual({ domain: 'acme.com', seats: 10 })
  })

  it("surfaces the server's own message on failure", async () => {
    mockFetch({ error: 'This address is already taken.' }, 409)
    await expect(generateMailInvoice(signer, { pubkey: 'p', nip05: 'a', tierId: 'base' })).rejects.toThrow(
      'This address is already taken.',
    )
  })

  it('reads the seat price unauthenticated and reports failure', async () => {
    const spy = mockFetch({ pricePerSeatSats: 20, minSeats: 1, maxSeats: 1000 })
    expect(await fetchSeatPricing()).toEqual({ pricePerSeatSats: 20, minSeats: 1, maxSeats: 1000 })
    expect(spy.mock.calls[0]).toHaveLength(1)
    mockFetch({}, 500)
    await expect(fetchSeatPricing()).rejects.toThrow()
  })

  it('reads sats from the tier pricing passthrough', () => {
    const tier = normalizeTier({ id: 'base', name: 'Mail', priceSats: 1000, unit: 'sats' })!
    expect(tierSats(tier)).toEqual({ amount: 1000, unit: 'sats' })
    expect(tierSats(normalizeTier({ id: 'x' })!)).toBeNull()
  })

  it('reads an order total in sats for mail and seats', async () => {
    const tier = normalizeTier({ id: 'base', name: 'Mail', priceSats: 1000, unit: 'sats' })!
    expect(
      await orderSats({ product: 'mail', pubkey: 'p', nip05: 'a@b', tierId: 'base' }, tier),
    ).toEqual({ amount: 1000, unit: 'sats' })

    mockFetch({ pricePerSeatSats: 90, minSeats: 1, maxSeats: 100 })
    expect(await orderSats({ product: 'workspace', domain: 'acme.com', seats: 10 })).toEqual({
      amount: 900,
      unit: 'sats',
    })
  })
})
