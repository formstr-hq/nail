import { describe, it, expect } from 'vitest'
import { formatUsd } from './money'

describe('formatUsd', () => {
  it('formats USD cents', () => {
    expect(formatUsd(500, 'en-US')).toBe('$5.00')
    expect(formatUsd(99, 'en-US')).toBe('$0.99')
    expect(formatUsd(1000, 'en-US')).toBe('$10.00')
  })
})
