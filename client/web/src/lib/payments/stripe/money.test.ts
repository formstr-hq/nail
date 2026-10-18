import { describe, it, expect } from 'vitest'
import { currencyForLocale, formatMoney, resolveDisplayCurrency } from './money'

const offered = [
  { code: 'usd', name: 'US dollar', exponent: 2 },
  { code: 'eur', name: 'Euro', exponent: 2 },
  { code: 'jpy', name: 'Yen', exponent: 0 },
]

describe('formatMoney', () => {
  it('formats minor units with the currency exponent', () => {
    expect(formatMoney(562, 'eur', 2, 'en-US')).toBe('€5.62')
    expect(formatMoney(500, 'usd', 2, 'en-US')).toBe('$5.00')
    expect(formatMoney(750, 'jpy', 0, 'en-US')).toBe('¥750')
  })
  it('falls back to a plain amount for an unknown currency code', () => {
    expect(formatMoney(100, 'zz', 2)).toMatch(/1\.00/)
  })
})

describe('currencyForLocale', () => {
  it('maps regions to currencies', () => {
    expect(currencyForLocale('de-DE')).toBe('eur')
    expect(currencyForLocale('en-GB')).toBe('gbp')
    expect(currencyForLocale('ja-JP')).toBe('jpy')
    expect(currencyForLocale('en')).toBeNull()
    expect(currencyForLocale('xx-ZZ')).toBeNull()
  })
})

describe('resolveDisplayCurrency', () => {
  it('prefers the remembered choice, including sats', () => {
    expect(resolveDisplayCurrency('eur', offered, 'en-US')).toBe('eur')
    expect(resolveDisplayCurrency('sats', offered, 'en-US')).toBe('sats')
  })
  it('ignores a remembered currency that is no longer offered', () => {
    expect(resolveDisplayCurrency('chf', offered, 'de-DE')).toBe('eur')
  })
  it('then the locale, then USD, then the first offered', () => {
    expect(resolveDisplayCurrency(null, offered, 'ja-JP')).toBe('jpy')
    expect(resolveDisplayCurrency(null, offered, 'pt-BR')).toBe('usd')
    expect(resolveDisplayCurrency(null, [offered[1]], 'pt-BR')).toBe('eur')
    expect(resolveDisplayCurrency(null, [], 'en-US')).toBe('sats')
  })
})
