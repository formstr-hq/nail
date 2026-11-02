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

/** Lightning prices are sats; the unit comes from the backend's tier pricing. */
export function formatSats(amount: number, unit = 'sats', locale?: string): string {
  try {
    return `${new Intl.NumberFormat(locale).format(amount)} ${unit}`
  } catch {
    return `${amount} ${unit}`
  }
}
