// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  fetchPaymentsConfig: vi.fn(),
  fetchPaymentCurrencies: vi.fn(),
  fetchPaymentQuote: vi.fn(),
  createCheckout: vi.fn(),
  fetchOrderStatus: vi.fn(),
}))
vi.mock('@/lib/payments/stripe/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/stripe/api')>()),
  ...api,
}))

const pricing = vi.hoisted(() => ({
  currentMailPriceUsd: vi.fn(),
  currentSeatTotalUsd: vi.fn(),
}))
vi.mock('@/lib/payments/pricing', () => pricing)

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
import { PriceChanged } from '@/lib/payments/stripe/api'
import { useCurrencyPreference } from '@/lib/payments/preferences'

const order = { product: 'mail', pubkey: 'p', nip05: 'alice@mailstr.app', tierId: 'base' } as const
const signer = { signEvent: vi.fn() } as never

function setup(props: { priceUsd?: number | null; currency?: string } = {}, strict = false) {
  const onResult = vi.fn()
  const onError = vi.fn()
  const onPriceUsdChange = vi.fn()
  const sheet = (
    <StripePay
      order={order}
      signer={signer}
      priceUsd={props.priceUsd === undefined ? 500 : props.priceUsd}
      currency={props.currency}
      onPriceUsdChange={onPriceUsdChange}
      onResult={onResult}
      onError={onError}
    />
  )
  render(strict ? <StrictMode>{sheet}</StrictMode> : sheet)
  return { onResult, onError, onPriceUsdChange }
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  embedded.onComplete = undefined
  // The remembered currency persists in localStorage; every test starts on USD.
  useCurrencyPreference.setState({ currency: 'usd' })
  api.fetchPaymentsConfig.mockResolvedValue({
    stripe: { enabled: true, publishableKey: 'pk_test' },
    lightning: { enabled: true },
  })
  api.fetchPaymentCurrencies.mockResolvedValue(['usd'])
})

describe('StripePay', () => {
  it('shows the fixed USD price, charges it and waits for the backend to say paid', async () => {
    api.createCheckout.mockResolvedValue({ sessionId: 'cs_1', clientSecret: 'secret', amount: 500, currency: 'usd' })
    api.fetchOrderStatus.mockResolvedValue({ status: 'paid' })
    const user = userEvent.setup()
    const { onResult } = setup()

    expect(await screen.findByText('$5.00')).toBeTruthy()
    expect(screen.getByText(/tax included/)).toBeTruthy()
    // With only usd offered there is no currency picker and no FX estimate.
    expect(screen.queryByRole('combobox', { name: 'Card currency' })).toBeNull()

    await user.click(screen.getByRole('button', { name: /^pay$/i }))
    expect(api.createCheckout).toHaveBeenCalledWith(
      signer,
      expect.objectContaining({
        product: 'mail',
        expectedPriceUsd: 500,
        currency: 'usd',
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

  it('uses a white, dark-text pay button in the workspace flow', async () => {
    render(
      <StripePay
        order={{ product: 'workspace', domain: 'acme.com', seats: 1 }}
        signer={signer}
        priceUsd={500}
        onResult={vi.fn()}
        onError={vi.fn()}
      />,
    )
    const pay = await screen.findByRole('button', { name: /^pay$/i })
    expect(pay.className).toContain('bg-white')
    expect(pay.className).toContain('text-ink')
    expect(pay.className).not.toContain('bg-primary')
  })

  it('still settles after StrictMode remounts the panel', async () => {
    api.createCheckout.mockResolvedValue({ sessionId: 'cs_strict', clientSecret: 'secret', amount: 500, currency: 'usd' })
    api.fetchOrderStatus.mockResolvedValue({ status: 'paid' })
    const user = userEvent.setup()
    const { onResult } = setup({}, true)

    await user.click(await screen.findByRole('button', { name: /^pay$/i }))
    await screen.findByText('Stripe Embedded Checkout')
    embedded.onComplete?.()
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'paid' }))
  })

  it('refreshes the price and asks again when the config changed', async () => {
    api.createCheckout.mockRejectedValue(new PriceChanged())
    pricing.currentMailPriceUsd.mockResolvedValue(550)
    const user = userEvent.setup()
    const { onPriceUsdChange } = setup()

    await user.click(await screen.findByRole('button', { name: /^pay$/i }))
    expect(await screen.findByText(/The price was updated/)).toBeTruthy()
    await waitFor(() => expect(onPriceUsdChange).toHaveBeenCalledWith(550))
    expect(api.createCheckout).toHaveBeenCalledTimes(1)
  })

  it('does not offer card when it is disabled on the server', async () => {
    api.fetchPaymentsConfig.mockResolvedValue({ stripe: { enabled: false, publishableKey: null }, lightning: { enabled: true } })
    const { onError } = setup()
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/not available/)))
    expect(api.createCheckout).not.toHaveBeenCalled()
  })

  it('charges the backend-quoted amount in the chosen currency and remembers the choice', async () => {
    api.fetchPaymentCurrencies.mockResolvedValue(['usd', 'eur'])
    api.fetchPaymentQuote.mockResolvedValue({
      currency: 'eur',
      amount: 460,
      exponent: 2,
      usdCents: 500,
      estimate: true,
      fetchedAt: '2026-11-02T00:00:00Z',
    })
    api.createCheckout.mockResolvedValue({ sessionId: 'cs_eur', clientSecret: 's', amount: 460, currency: 'eur' })
    const user = userEvent.setup()
    setup()

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Card currency' }), 'eur')
    expect(await screen.findByText(/4[.,]60/)).toBeTruthy()
    expect(screen.getByText(/final price may change with the exchange rate/)).toBeTruthy()
    expect(api.fetchPaymentQuote).toHaveBeenCalledWith({ product: 'mail', currency: 'eur', seats: undefined })

    await user.click(screen.getByRole('button', { name: /^pay$/i }))
    expect(api.createCheckout).toHaveBeenCalledWith(signer, expect.objectContaining({ currency: 'eur', expectedPriceUsd: 500 }))
    expect(useCurrencyPreference.getState().currency).toBe('eur')
  })

  it('uses the currency chosen on the first panel without showing the card picker', async () => {
    api.fetchPaymentQuote.mockResolvedValue({
      currency: 'eur',
      amount: 460,
      exponent: 2,
      usdCents: 500,
      estimate: true,
      fetchedAt: '2026-11-02T00:00:00Z',
    })
    api.createCheckout.mockResolvedValue({ sessionId: 'cs_locked', clientSecret: 's', amount: 460, currency: 'eur' })
    const user = userEvent.setup()
    setup({ currency: 'eur' })

    expect(await screen.findByText(/4[.,]60/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Card currency' })).toBeNull()
    expect(api.fetchPaymentCurrencies).not.toHaveBeenCalled()
    expect(api.fetchPaymentQuote).toHaveBeenCalledWith({ product: 'mail', currency: 'eur', seats: undefined })

    await user.click(screen.getByRole('button', { name: /^pay$/i }))
    expect(api.createCheckout).toHaveBeenCalledWith(signer, expect.objectContaining({ currency: 'eur' }))
  })

  it('reports a paid-but-not-delivered order from the backend as needs_attention', async () => {
    api.createCheckout.mockResolvedValue({ sessionId: 'cs_2', clientSecret: 's', amount: 500, currency: 'usd' })
    api.fetchOrderStatus.mockResolvedValue({ status: 'needs_attention' })
    const user = userEvent.setup()
    const { onResult } = setup()
    await user.click(await screen.findByRole('button', { name: /^pay$/i }))
    await screen.findByText('Stripe Embedded Checkout')
    embedded.onComplete?.()
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'needs_attention' }))
  })
})
