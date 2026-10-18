import { useEffect, useState } from 'react'
import { formatMoney, SATS_CURRENCY } from '@/lib/payments/stripe/money'
import { useDisplayCurrency } from '@/lib/payments/stripe/useDisplayCurrency'
import { indicativeQuote } from '@/lib/payments/stripe/quotes'
import { fetchSeatPricing, tierSats } from '@/lib/payments/lightning/api'
import type { PriceSubject } from './PriceTag'

/** Sats for the subject, or null while unknown. */
function useSats(subject: PriceSubject): { amount: number; unit: string } | null {
  const [seatPrice, setSeatPrice] = useState<number | null>(null)
  useEffect(() => {
    if (subject.kind !== 'seats') return
    let cancelled = false
    fetchSeatPricing()
      .then((p) => !cancelled && setSeatPrice(p.pricePerSeatSats))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [subject.kind])
  if (subject.kind === 'mail') return tierSats(subject.tier)
  return seatPrice === null ? null : { amount: seatPrice * subject.seats, unit: 'sats' }
}

/**
 * Open builds: an indicative price in the buyer's chosen currency, or sats when
 * they chose sats, card pricing is off, or the quote fails (no error banner:
 * Lightning keeps working and the sats price is still true).
 */
export default function OpenPrice({ subject }: { subject: PriceSubject }) {
  const { list, display } = useDisplayCurrency()
  const sats = useSats(subject)
  const [fiat, setFiat] = useState<string | null>(null)

  const wantsFiat = !!list && display !== SATS_CURRENCY
  const mailTierId = subject.kind === 'mail' ? subject.tier.id : null
  const seats = subject.kind === 'seats' ? subject.seats : null
  useEffect(() => {
    setFiat(null)
    if (!wantsFiat) return
    let cancelled = false
    const request =
      mailTierId !== null
        ? ({ product: 'mail', currency: display, tierId: mailTierId } as const)
        : seats !== null && seats > 0
          ? ({ product: 'workspace', currency: display, seats } as const)
          : null
    if (!request) return
    indicativeQuote(request)
      .then((q) => !cancelled && setFiat(formatMoney(q.amountMinor, q.currency, q.exponent)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [wantsFiat, display, mailTierId, seats])

  if (fiat) return <span>{fiat}</span>
  if (sats) {
    return (
      <>
        <span>{sats.amount.toLocaleString()}</span>{' '}
        <span className="text-sm font-normal text-gray-500">{sats.unit}</span>
      </>
    )
  }
  return <span className="text-gray-300">…</span>
}
