// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  fetchPaymentCurrencies: vi.fn(),
  fetchPaymentsConfig: vi.fn(),
}))
vi.mock('@/lib/payments/stripe/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/stripe/api')>()),
  ...api,
}))

import PayInPicker from './PayInPicker'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  api.fetchPaymentsConfig.mockResolvedValue({
    stripe: { enabled: true, publishableKey: 'pk_test' },
    lightning: { enabled: true },
  })
  api.fetchPaymentCurrencies.mockResolvedValue(['usd', 'eur'])
})

describe('PayInPicker', () => {
  it('puts Bitcoin first, searches currencies, and reports the chosen code', async () => {
    const onChange = vi.fn()
    const onChoiceChange = vi.fn()
    const user = userEvent.setup()
    render(<PayInPicker value="usd" onChange={onChange} onChoiceChange={onChoiceChange} />)

    const trigger = await screen.findByRole('button', { name: 'Pay in' })
    await waitFor(() => expect(trigger.textContent).toContain('USD'))
    expect(onChoiceChange).toHaveBeenCalledWith({ methodId: 'stripe', currency: 'usd', autoStart: true })
    await user.click(trigger)

    expect(screen.getAllByRole('option')[0].textContent).toContain('Bitcoin (Sats)')

    await user.type(screen.getByRole('textbox', { name: 'Search currency' }), 'eur')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.click(screen.getByRole('option', { name: /EUR/ }))

    expect(onChange).toHaveBeenCalledWith('eur')
  })

  it('falls back to Bitcoin when card payments are disabled', async () => {
    api.fetchPaymentsConfig.mockResolvedValue({
      stripe: { enabled: false, publishableKey: null },
      lightning: { enabled: true },
    })
    const onChange = vi.fn()
    const onChoiceChange = vi.fn()
    render(<PayInPicker value="usd" onChange={onChange} onChoiceChange={onChoiceChange} />)

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('sats'))
    expect(onChoiceChange).toHaveBeenCalledWith({ methodId: 'lightning' })
    const trigger = await screen.findByRole('button', { name: 'Pay in' })
    await waitFor(() => expect(trigger.textContent).toContain('Bitcoin (Sats)'))
  })
})
