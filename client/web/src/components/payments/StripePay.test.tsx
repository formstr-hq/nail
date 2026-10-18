// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  fetchPaymentsConfig: vi.fn(),
  fetchCurrencies: vi.fn(),
  requestQuote: vi.fn(),
  createCheckout: vi.fn(),
  fetchOrderStatus: vi.fn(),
}))
vi.mock('@/lib/payments/stripe/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/stripe/api')>()),
  ...api,
}))

// Embedded Checkout is Stripe's iframe: stand in for it and expose its completion callback.
const embedded = vi.hoisted(() => ({ onComplete: undefined as undefined | (() => void) }))
vi.mock('@stripe/react-stripe-js', () => ({
  EmbeddedCheckoutProvider: ({ options, children }: { options: { onComplete?: () => void }; children: React.ReactNode }) => {
    embedded.onComplete = options.onComplete
    return <div data-testid="provider">{children}</div>
  },
  EmbeddedCheckout: () => <div>Stripe Embedded Checkout</div>,
}))
vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: vi.fn(async () => ({})) }))

import StripePay from './StripePay'
import { CardUnavailable, QuoteConflict } from '@/lib/payments/stripe/api'
import { useCurrencyPreference } from '@/lib/payments/stripe/preferences'

const CURRENCIES = [
  { code: 'usd', name: 'US dollar', exponent: 2 },
  { code: 'eur', name: 'Euro', exponent: 2 },
]
const quote = (amountMinor: number, currency = 'usd', extra: Record<string, unknown> = {}) => ({
  currency,
  exponent: 2,
  amountMinor,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  quoteToken: `tok-${amountMinor}`,
  ...extra,
})

const order = { product: 'mail', pubkey: 'p', nip05: 'alice@mailstr.app', tierId: 'base' } as const
const signer = { signEvent: vi.fn() } as never

function setup() {
  const onResult = vi.fn()
  const onError = vi.fn()
  render(<StripePay order={order} signer={signer} onResult={onResult} onError={onError} />)
  return { onResult, onError }
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  embedded.onComplete = undefined
  useCurrencyPreference.setState({ currency: 'usd' })
  api.fetchPaymentsConfig.mockResolvedValue({ stripe: { enabled: true, publishableKey: 'pk_test' }, lightning: { enabled: true } })
  api.fetchCurrencies.mockResolvedValue({ currencies: CURRENCIES, default: 'usd' })
  api.requestQuote.mockResolvedValue(quote(546))
})

describe('StripePay', () => {
  it('shows the quoted price, charges exactly that quote and waits for the backend to say paid', async () => {
    api.createCheckout.mockResolvedValue({ sessionId: 'cs_1', clientSecret: 'secret', amount: 546, currency: 'usd' })
    api.fetchOrderStatus.mockResolvedValue({ status: 'paid' })
    const user = userEvent.setup()
    const { onResult } = setup()

    expect(await screen.findByText('$5.46')).toBeTruthy()
    expect(api.requestQuote).toHaveBeenCalledWith({ product: 'mail', currency: 'usd', tierId: 'base' })

    await user.click(screen.getByRole('button', { name: /Accept and pay \$5\.46/ }))
    expect(api.createCheckout).toHaveBeenCalledWith(
      signer,
      expect.objectContaining({
        product: 'mail',
        quoteToken: 'tok-546',
        uiMode: 'embedded',
        tierId: 'base',
        nip05: 'alice@mailstr.app',
      }),
    )
    expect(await screen.findByText('Stripe Embedded Checkout')).toBeTruthy()

    // The browser saying "done" is not enough: only the backend's answer settles it.
    expect(onResult).not.toHaveBeenCalled()
    embedded.onComplete?.()
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'paid' }))
    expect(api.fetchOrderStatus).toHaveBeenCalledWith('cs_1')
  })

  it('shows the new price and asks again when checkout refuses the quote', async () => {
    api.requestQuote.mockResolvedValueOnce(quote(562)).mockResolvedValueOnce(quote(571))
    api.createCheckout.mockRejectedValue(new QuoteConflict('price_changed'))
    const user = userEvent.setup()
    setup()

    await user.click(await screen.findByRole('button', { name: /Accept and pay \$5\.62/ }))
    expect(await screen.findByText(/The price was updated/)).toBeTruthy()
    expect(await screen.findByText('$5.71')).toBeTruthy()
    expect(screen.getByText(/was \$5\.62/)).toBeTruthy()
    // Nothing was charged: the buyer must accept the new price explicitly.
    expect(api.createCheckout).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /Accept and pay \$5\.71/ })).toBeTruthy()
  })

  it('re-quotes when the buyer changes currency', async () => {
    api.requestQuote.mockImplementation(async (r: { currency: string }) =>
      r.currency === 'eur' ? quote(562, 'eur') : quote(546),
    )
    const user = userEvent.setup()
    setup()
    await screen.findByText('$5.46')
    await user.selectOptions(screen.getByLabelText('Pay in'), 'eur')
    expect(await screen.findByText('€5.62')).toBeTruthy()
    expect(useCurrencyPreference.getState().currency).toBe('eur')
  })

  it('points to Lightning when card prices are unavailable', async () => {
    api.requestQuote.mockRejectedValue(new CardUnavailable('stale'))
    const { onError } = setup()
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/Lightning/)))
  })

  it('reports a paid-but-not-delivered order from the backend as needs_attention', async () => {
    api.createCheckout.mockResolvedValue({ sessionId: 'cs_2', clientSecret: 's', amount: 546, currency: 'usd' })
    api.fetchOrderStatus.mockResolvedValue({ status: 'needs_attention' })
    const user = userEvent.setup()
    const { onResult } = setup()
    await user.click(await screen.findByRole('button', { name: /Accept and pay/ }))
    await screen.findByText('Stripe Embedded Checkout')
    embedded.onComplete?.()
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'needs_attention' }))
  })

  it('does not offer card when it is disabled on the server', async () => {
    api.fetchPaymentsConfig.mockResolvedValue({ stripe: { enabled: false, publishableKey: null }, lightning: { enabled: true } })
    const { onError } = setup()
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/not available/)))
    expect(api.requestQuote).not.toHaveBeenCalled()
  })
})
