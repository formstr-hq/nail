import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import InvoiceQR from './InvoiceQR'
import {
  createSeatInvoice,
  generateMailInvoice,
  tierSats,
  type LightningInvoice,
} from '@/lib/payments/lightning/api'
import type { MethodProps } from '@/lib/payments/types'

/** The payment method that shows a Lightning invoice and waits for it to settle. */
export default function LightningPay({ order, signer, tier, onResult, onError }: MethodProps) {
  const [invoice, setInvoice] = useState<LightningInvoice | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // The invoice is requested when this method is first shown, so choosing
  // another method never creates one (nor a relay listener).
  useEffect(() => {
    let cancelled = false
    // Defer the request by a tick. React StrictMode mounts, cleans up and
    // mounts again in dev; without the timer that produced two invoices and
    // two relay listeners for one click.
    const timer = setTimeout(() => {
      if (cancelled) return
      setInvoice(null)
      setFailed(false)
      onError(null)
      const request =
        order.product === 'mail'
          ? generateMailInvoice(signer, { pubkey: order.pubkey, nip05: order.nip05, tierId: order.tierId })
          : 'seats' in order
            ? createSeatInvoice(signer, order.domain, order.seats)
            : Promise.reject(new Error('Seat packs are only sold in the app stores'))
      request
        .then((inv) => {
          if (!cancelled) setInvoice(inv)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setFailed(true)
          onError(err instanceof Error ? err.message : 'Invoice request failed')
        })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // The order and signer identify the invoice; onError is a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, signer, JSON.stringify(order)])

  const handlePaid = useCallback(() => onResult({ status: 'paid' }), [onResult])
  const handleFailed = useCallback(
    (message: string) => {
      // "Payment received but ... could not be provisioned": paid, not delivered.
      if (/could not be provisioned/i.test(message)) onResult({ status: 'needs_attention', reason: message })
    },
    [onResult],
  )

  if (failed) {
    return (
      <button
        type="button"
        onClick={() => setAttempt((n) => n + 1)}
        className="w-full rounded-xl border border-black/10 px-4 py-3 text-sm font-semibold text-ink hover:bg-black/[0.04]"
      >
        Try again
      </button>
    )
  }
  if (!invoice) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" /> Preparing invoice…
      </div>
    )
  }
  return (
    <InvoiceQR
      invoice={invoice.invoice}
      hash={invoice.paymentHash}
      amount={invoice.amount}
      unit={(tier && tierSats(tier)?.unit) || 'sats'}
      onPaid={handlePaid}
      onFailed={handleFailed}
    />
  )
}
