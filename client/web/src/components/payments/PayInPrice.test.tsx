// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

const api = vi.hoisted(() => ({ fetchPaymentQuote: vi.fn() }))
vi.mock('@/lib/payments/stripe/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/stripe/api')>()),
  ...api,
}))

import { normalizeTier } from '@/lib/api'
import PayInPrice from './PayInPrice'

const tier = normalizeTier({ id: 'base', name: 'Mail', priceUsd: 149, priceSats: 1500, unit: 'sats' })!

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PayInPrice', () => {
  it('shows the tier price in sats', () => {
    render(<PayInPrice tier={tier} payIn="sats" />)
    expect(screen.getByText(/1[,.]500 sats/)).toBeTruthy()
    expect(api.fetchPaymentQuote).not.toHaveBeenCalled()
  })

  it('shows the fixed USD price without an FX call', () => {
    render(<PayInPrice tier={tier} payIn="usd" />)
    expect(screen.getByText('$1.49')).toBeTruthy()
    expect(api.fetchPaymentQuote).not.toHaveBeenCalled()
  })

  it('shows the backend quote in a fiat currency', async () => {
    api.fetchPaymentQuote.mockResolvedValue({
      currency: 'eur',
      amount: 138,
      exponent: 2,
      usdCents: 149,
      estimate: true,
      fetchedAt: '2026-11-02T00:00:00Z',
    })
    render(<PayInPrice tier={tier} payIn="eur" />)
    expect(await screen.findByText(/1[.,]38/)).toBeTruthy()
    expect(api.fetchPaymentQuote).toHaveBeenCalledWith({ product: 'mail', currency: 'eur' })
  })

  it('shows a dash when the rate cannot be loaded', async () => {
    api.fetchPaymentQuote.mockRejectedValue(new Error('offline'))
    render(<PayInPrice tier={tier} payIn="eur" />)
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy())
  })
})
