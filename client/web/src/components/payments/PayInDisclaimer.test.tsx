// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PayInDisclaimer from './PayInDisclaimer'

describe('PayInDisclaimer', () => {
  it('shows the card disclosure for a fiat choice', () => {
    render(<PayInDisclaimer payIn="eur" />)
    expect(screen.getByText(/sold through Stripe/i)).toBeTruthy()
    expect(screen.getByText(/may see your IP/i)).toBeTruthy()
  })

  it('renders nothing for sats', () => {
    const { container } = render(<PayInDisclaimer payIn="sats" />)
    expect(container.firstChild).toBeNull()
  })
})
