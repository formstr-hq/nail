// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MethodProps } from '@/lib/payments/types'

const methods = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock('@/lib/payments/methods', () => ({ availableMethods: async () => methods.list }))

import { PaymentSheet } from './PaymentSheet'
import { useMethodPreference } from '@/lib/payments/preferences'

function method(id: string, label: string, behaviour?: (p: MethodProps) => void) {
  return {
    id,
    label,
    Component: (props: MethodProps) => {
      behaviour?.(props)
      return <div data-testid="method">{label} panel</div>
    },
  }
}

const order = { product: 'mail', pubkey: 'p', nip05: 'a@b', tierId: 'base' } as const
const signer = { signEvent: vi.fn() } as never

beforeEach(() => {
  cleanup()
  useMethodPreference.setState({ method: null })
})

describe('PaymentSheet', () => {
  it('opens on the build\'s first method and shows a picker when there are several', async () => {
    methods.list = [method('one', 'One'), method('two', 'Two')]
    render(<PaymentSheet order={order} signer={signer} onPaid={() => {}} />)
    expect(await screen.findByText('One panel')).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Payment method' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'One' }).getAttribute('aria-checked')).toBe('true')
  })

  it('hides the picker when only one method is offered', async () => {
    methods.list = [method('only', 'Only')]
    render(<PaymentSheet order={order} signer={signer} onPaid={() => {}} />)
    expect(await screen.findByText('Only panel')).toBeTruthy()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('switching methods remembers the choice and mounts only the chosen method', async () => {
    const mountedOne = vi.fn()
    const mountedTwo = vi.fn()
    methods.list = [method('one', 'One', mountedOne), method('two', 'Two', mountedTwo)]
    const user = userEvent.setup()
    render(<PaymentSheet order={order} signer={signer} onPaid={() => {}} />)
    await screen.findByText('One panel')
    expect(mountedTwo).not.toHaveBeenCalled()

    await user.click(screen.getByRole('radio', { name: 'Two' }))
    expect(await screen.findByText('Two panel')).toBeTruthy()
    expect(useMethodPreference.getState().method).toBe('two')
  })

  it('honours a remembered method that is still offered', async () => {
    useMethodPreference.setState({ method: 'two' })
    methods.list = [method('one', 'One'), method('two', 'Two')]
    render(<PaymentSheet order={order} signer={signer} onPaid={() => {}} />)
    expect(await screen.findByText('Two panel')).toBeTruthy()
  })

  it('arrow keys move the selection', async () => {
    methods.list = [method('one', 'One'), method('two', 'Two')]
    const user = userEvent.setup()
    render(<PaymentSheet order={order} signer={signer} onPaid={() => {}} />)
    await screen.findByText('One panel')
    screen.getByRole('radio', { name: 'One' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(await screen.findByText('Two panel')).toBeTruthy()
  })

  it('calls onPaid only when the method reports paid', async () => {
    const onPaid = vi.fn()
    methods.list = [
      method('one', 'One', (p) => {
        queueMicrotask(() => p.onResult({ status: 'paid' }))
      }),
    ]
    render(<PaymentSheet order={order} signer={signer} onPaid={onPaid} />)
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1))
  })

  it('shows a paid-but-not-delivered result as a terminal error, never a spinner', async () => {
    const onPaid = vi.fn()
    methods.list = [
      method('one', 'One', (p) => {
        queueMicrotask(() => p.onResult({ status: 'needs_attention', reason: 'alice@x was claimed first' }))
      }),
    ]
    render(<PaymentSheet order={order} signer={signer} onPaid={onPaid} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/claimed first/)).toBeTruthy()
    expect(onPaid).not.toHaveBeenCalled()
  })

  it('shows a message when no method is available', async () => {
    methods.list = []
    render(<PaymentSheet order={order} signer={signer} onPaid={() => {}} />)
    expect(await screen.findByText(/No payment method is available/)).toBeTruthy()
  })

  it('shows a method\'s error banner', async () => {
    methods.list = [
      method('one', 'One', (p) => {
        queueMicrotask(() => p.onError('Card prices are temporarily unavailable.'))
      }),
    ]
    render(<PaymentSheet order={order} signer={signer} onPaid={() => {}} />)
    expect(await screen.findByText(/temporarily unavailable/)).toBeTruthy()
  })
})
