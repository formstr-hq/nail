// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  generateMailInvoice: vi.fn(),
  createSeatInvoice: vi.fn(),
}))
vi.mock('@/lib/payments/lightning/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/lightning/api')>()),
  ...api,
}))

// The settlement socket: capture it so a test can deliver the backend's message.
const sockets = vi.hoisted(() => ({ last: null as null | { onmessage?: (e: { data: string }) => void; close: () => void } }))
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => <svg /> }))

import LightningPay from './LightningPay'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.stubGlobal(
    'WebSocket',
    class {
      onmessage?: (e: { data: string }) => void
      onerror?: () => void
      close = vi.fn()
      constructor() {
        sockets.last = this as never
      }
    },
  )
})

const signer = { signEvent: vi.fn() } as never
const mailOrder = { product: 'mail', pubkey: 'p', nip05: 'alice@mailstr.app', tierId: 'base' } as const
const INVOICE = { invoice: 'lnbc1abc', paymentHash: 'h1', amount: 1000 }

describe('LightningPay', () => {
  it('requests a mail invoice when shown, then reports paid when the socket says so', async () => {
    api.generateMailInvoice.mockResolvedValue(INVOICE)
    const onResult = vi.fn()
    render(<LightningPay order={mailOrder} signer={signer} onResult={onResult} onError={vi.fn()} />)

    expect(await screen.findByText('lnbc1abc')).toBeTruthy()
    expect(api.generateMailInvoice).toHaveBeenCalledWith(signer, { pubkey: 'p', nip05: 'alice@mailstr.app', tierId: 'base' })

    sockets.last!.onmessage!({ data: JSON.stringify({ status: 'paid' }) })
    expect(onResult).toHaveBeenCalledWith({ status: 'paid' })
  })

  it('requests a seat invoice for a seat order', async () => {
    api.createSeatInvoice.mockResolvedValue({ ...INVOICE, seats: 10, pricePerSeatSats: 90 })
    render(
      <LightningPay
        order={{ product: 'workspace', domain: 'acme.com', seats: 10 }}
        signer={signer}
        onResult={vi.fn()}
        onError={vi.fn()}
      />,
    )
    await screen.findByText('lnbc1abc')
    expect(api.createSeatInvoice).toHaveBeenCalledWith(signer, 'acme.com', 10)
  })

  it('turns a paid-but-not-provisioned message into needs_attention', async () => {
    api.generateMailInvoice.mockResolvedValue(INVOICE)
    const onResult = vi.fn()
    render(<LightningPay order={mailOrder} signer={signer} onResult={onResult} onError={vi.fn()} />)
    await screen.findByText('lnbc1abc')
    sockets.last!.onmessage!({
      data: JSON.stringify({ status: 'error', message: 'Payment received but your mail could not be provisioned: taken' }),
    })
    expect(onResult).toHaveBeenCalledWith({
      status: 'needs_attention',
      reason: expect.stringContaining('taken'),
    })
  })

  it('shows the server\'s reason and a retry when the invoice request fails', async () => {
    api.generateMailInvoice.mockRejectedValueOnce(new Error('This address is already taken.')).mockResolvedValueOnce(INVOICE)
    const onError = vi.fn()
    const user = userEvent.setup()
    render(<LightningPay order={mailOrder} signer={signer} onResult={vi.fn()} onError={onError} />)

    await waitFor(() => expect(onError).toHaveBeenCalledWith('This address is already taken.'))
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('lnbc1abc')).toBeTruthy()
    expect(api.generateMailInvoice).toHaveBeenCalledTimes(2)
  })

  it('refuses a seat pack order (packs only exist in the stores)', async () => {
    const onError = vi.fn()
    render(
      <LightningPay
        order={{ product: 'workspace', domain: 'acme.com', packSeats: 10 }}
        signer={signer}
        onResult={vi.fn()}
        onError={onError}
      />,
    )
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/app stores/)))
  })
})
