import { describe, it, expect } from 'vitest'
import { formatSats, formatUsd } from './money'

describe('formatUsd', () => {
  it('formats USD cents', () => {
    expect(formatUsd(500, 'en-US')).toBe('$5.00')
    expect(formatUsd(99, 'en-US')).toBe('$0.99')
    expect(formatUsd(1000, 'en-US')).toBe('$10.00')
  })
})

describe('formatSats', () => {
  it('formats sats with the backend unit', () => {
    expect(formatSats(1000, 'sats', 'en-US')).toBe('1,000 sats')
    expect(formatSats(21, 'sat', 'en-US')).toBe('21 sat')
  })
})
