/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, installGlobalErrorCapture, isBenignError } from './DebugErrorOverlay'
import { render, screen } from '@testing-library/react'
import '@/app/components/test-utils'

function Boom(): never {
  throw new Error('render exploded')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isBenignError', () => {
  it('recognizes both ResizeObserver loop notification forms', () => {
    expect(isBenignError('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
    expect(isBenignError('ResizeObserver loop limit exceeded')).toBe(true)
  })

  it('does not swallow real errors', () => {
    expect(isBenignError('Failed to fetch')).toBe(false)
    expect(isBenignError('Cannot read properties of undefined')).toBe(false)
  })
})

describe('installGlobalErrorCapture', () => {
  it('installs listeners so a real error is not lost', () => {
    const add = vi.spyOn(window, 'addEventListener')
    installGlobalErrorCapture()
    expect(add.mock.calls.some(([type]) => type === 'error')).toBe(true)
  })
})

describe('ErrorBoundary (test build runs with DEV=true)', () => {
  it('surfaces a render crash instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    // The overlay shows the boundary header plus the captured render error
    // (message and stack both mention it, hence getAllByText).
    expect(screen.getByText(/app error \(1\)/i)).toBeTruthy()
    expect(screen.getAllByText(/render exploded/).length).toBeGreaterThan(0)
  })
})
