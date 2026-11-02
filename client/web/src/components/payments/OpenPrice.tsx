import { useEffect, useState } from 'react'
import { formatUsd } from '@/lib/payments/money'
import { fetchSeatLimits } from '@/lib/payments/seatLimits'
import type { PriceSubject } from './PriceTag'

/**
 * Open builds: the fixed dollar price the backend configured. This is the only
 * price formstr itself shows before a payment method is chosen; sats appears
 * later, on the Lightning pay step only.
 */
export default function OpenPrice({ subject }: { subject: PriceSubject }) {
  const direct =
    subject.kind === 'mail' ? subject.tier.priceUsd : (subject.priceUsd ?? null)
  const [fetched, setFetched] = useState<number | null>(null)
  const seats = subject.kind === 'seats' ? subject.seats : null

  useEffect(() => {
    if (direct !== null || seats === null) return
    let cancelled = false
    void fetchSeatLimits().then((limits) => {
      if (!cancelled && limits.seatPriceUsd) setFetched(limits.seatPriceUsd * seats)
    })
    return () => {
      cancelled = true
    }
  }, [direct, seats])

  const cents = direct ?? fetched
  return <span>{cents === null ? '…' : formatUsd(cents)}</span>
}
