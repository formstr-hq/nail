/** Fixed card prices are always USD cents until Stripe/localises them. */
export function formatUsd(cents: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100)
  } catch {
    return `$${(cents / 100).toFixed(2)}`
  }
}

/** A card amount in its presentment currency: `amount` is in minor units (see the quote's exponent). */
export function formatCurrencyMinor(amount: number, currency: string, exponent: number, locale?: string): string {
  const code = currency.toUpperCase()
  const value = amount / 10 ** exponent
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(value)
  } catch {
    return `${code} ${value.toFixed(exponent)}`
  }
}

/** Lightning prices are sats; the unit comes from the backend's tier pricing. */
export function formatSats(amount: number, unit = 'sats', locale?: string): string {
  try {
    return `${new Intl.NumberFormat(locale).format(amount)} ${unit}`
  } catch {
    return `${amount} ${unit}`
  }
}
