// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  fetchPaymentsConfig: vi.fn(),
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

const order = { product: 'mail', pubkey: 'p', nip05: 'alice@mailstr.app', tierId: 'base' } as const
const signer = { signEvent: vi.fn() } as never

function setup(props: { priceUsd?: number | null } = {}, strict = false) {
  const onResult = vi.fn()
  const onError = vi.fn()
  const onPriceUsdChange = vi.fn()
  const sheet = (
    <StripePay
      order={order}
      signer={signer}
      priceUsd={props.priceUsd === undefined ? 500 : props.priceUsd}
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
  api.fetchPaymentsConfig.mockResolvedValue({
    stripe: { enabled: true, publishableKey: 'pk_test' },
    lightning: { enabled: true },
  })
})

describe('StripePay', () => {
  it('shows the fixed USD price, charges it and waits for the backend to say paid', async () => {
    api.createCheckout.mockResolvedValue({ sessionId: 'cs_1', clientSecret: 'secret', amount: 500, currency: 'usd' })
    api.fetchOrderStatus.mockResolvedValue({ status: 'paid' })
    const user = userEvent.setup()
    const { onResult } = setup()

    expect(await screen.findByText('$5.00')).toBeTruthy()
    expect(screen.getByText(/charged in your local currency/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /^pay$/i }))
    expect(api.createCheckout).toHaveBeenCalledWith(
      signer,
      expect.objectContaining({
        product: 'mail',
        expectedPriceUsd: 500,
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
