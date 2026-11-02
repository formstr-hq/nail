import { useEffect, useState } from 'react'
import type { MailTier } from '@/lib/api'
import { formatCurrencyMinor, formatSats, formatUsd } from '@/lib/payments/money'
import { fetchPaymentQuote, type PaymentQuote } from '@/lib/payments/stripe/api'

interface PayInPriceProps {
  tier: MailTier
  /** `sats` or a lowercase fiat code. */
  payIn: string
}

/**
 * The plan's price in whatever the buyer chose to pay in. Sats and USD come
 * from the tier itself; every other currency is the backend's live FX quote
 * (the client never calls an FX API).
 */
export default function PayInPrice({ tier, payIn }: PayInPriceProps) {
  const quoteKey = `${tier.id}:${payIn}`
  const [quoteState, setQuoteState] = useState<{
    key: string
    quote: PaymentQuote | null
    failed: boolean
  }>({ key: '', quote: null, failed: false })

  useEffect(() => {
    if (payIn === 'sats' || payIn === 'usd') return
    let cancelled = false
    fetchPaymentQuote({ product: 'mail', currency: payIn })
      .then((quote) => {
        if (!cancelled) setQuoteState({ key: quoteKey, quote, failed: false })
      })
      .catch(() => {
        if (!cancelled) setQuoteState({ key: quoteKey, quote: null, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [payIn, quoteKey])

  if (payIn === 'sats') {
    const amount = tier.pricing.priceSats
    if (typeof amount !== 'number') return <span className="text-gray-300">—</span>
    const unit = typeof tier.pricing.unit === 'string' ? tier.pricing.unit : 'sats'
    return <span>{formatSats(amount, unit)}</span>
  }

  if (payIn === 'usd') {
    return <span>{tier.priceUsd == null ? '—' : formatUsd(tier.priceUsd)}</span>
  }

  if (quoteState.key !== quoteKey || (!quoteState.quote && !quoteState.failed)) {
    return <span className="text-gray-300">…</span>
  }
  if (quoteState.failed || !quoteState.quote) {
    return <span className="text-gray-300">—</span>
  }
  return (
    <span>
      {formatCurrencyMinor(quoteState.quote.amount, quoteState.quote.currency, quoteState.quote.exponent)}
    </span>
  )
}
