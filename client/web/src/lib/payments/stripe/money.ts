import type { CurrencyInfo } from './api'

/** An amount in minor units as the buyer expects to read it, e.g. 562 EUR -> "€5.62". */
export function formatMoney(amountMinor: number, currency: string, exponent: number, locale?: string): string {
  const major = amountMinor / 10 ** exponent
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(major)
  } catch {
    return `${major.toFixed(exponent)} ${currency.toUpperCase()}`
  }
}

const EURO_REGIONS = new Set([
  'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
])
const REGION_CURRENCY: Record<string, string> = {
  US: 'usd', GB: 'gbp', CA: 'cad', AU: 'aud', CH: 'chf', JP: 'jpy',
  SE: 'sek', NO: 'nok', DK: 'dkk', NZ: 'nzd', SG: 'sgd', PL: 'pln', CZ: 'czk', KR: 'krw',
}

/** The currency a browser locale most likely wants, e.g. "de-DE" -> "eur". */
export function currencyForLocale(locale: string | undefined): string | null {
  const region = locale?.split('-')[1]?.toUpperCase()
  if (!region) return null
  if (EURO_REGIONS.has(region)) return 'eur'
  return REGION_CURRENCY[region] ?? null
}

/** Display currency sentinel for "show prices in sats". */
export const SATS_CURRENCY = 'sats'

/**
 * Which currency to show prices in: the buyer's last choice if still offered,
 * else the browser locale's currency if offered, else USD, else the first.
 */
export function resolveDisplayCurrency(
  stored: string | null,
  offered: readonly CurrencyInfo[],
  locale: string | undefined,
): string {
  if (stored === SATS_CURRENCY) return SATS_CURRENCY
  const has = (code: string | null): code is string => !!code && offered.some((c) => c.code === code)
  if (has(stored)) return stored
  const fromLocale = currencyForLocale(locale)
  if (has(fromLocale)) return fromLocale
  if (has('usd')) return 'usd'
  return offered[0]?.code ?? SATS_CURRENCY
}
