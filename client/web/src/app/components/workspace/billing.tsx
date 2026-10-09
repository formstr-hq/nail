import { useEffect, useState } from 'react'
import type { ActiveSigner } from '@formstr/signer'
import { Button } from '@/app/components/ui/Button'
import { Field, inputClass } from '@/app/components/settings/Field'
import InvoiceQR from '@/components/InvoiceQR'
import {
  createSeatInvoice,
  fetchSeatPrice,
  type SeatInvoice,
  type SeatPrice,
  type WorkspaceDomain,
} from '@/app/lib/api/workspace'

/** Clamp a raw input string to an optional non-negative integer. */
function parseInt0(value: string): number | null {
  const n = Number(value.trim())
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * Billing: buy seats for the workspace.
 *
 * Pricing is flat — one price per seat, no tiers — so the buyer chooses a
 * quantity rather than picking a pack. The price and its bounds come from the
 * server (the invoice is priced there too); this panel only reads them to show
 * a live total and to validate the input.
 */
export function SeatsPanel({
  active,
  domain,
  onPurchased,
}: {
  active: ActiveSigner
  domain: WorkspaceDomain
  onPurchased: () => Promise<void>
}) {
  const [price, setPrice] = useState<SeatPrice | null>(null)
  const [seats, setSeats] = useState('1')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [invoice, setInvoice] = useState<SeatInvoice | null>(null)

  useEffect(() => {
    fetchSeatPrice()
      .then(setPrice)
      .catch(() => {
        // Non-fatal: the invoice is priced server-side regardless; this only
        // affects the live total shown before buying.
      })
  }, [])

  const min = price?.minSeats ?? 1
  const max = price?.maxSeats ?? 1000
  const parsed = parseInt0(seats)
  const inRange = parsed != null && parsed >= min && parsed <= max
  const total =
    price && parsed != null && inRange ? price.pricePerSeatSats * parsed : null

  async function buy() {
    if (!inRange) return
    setBusy(true)
    setMessage(null)
    try {
      setInvoice(await createSeatInvoice(active, domain.domain, parsed))
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function paid() {
    setInvoice(null)
    await onPurchased()
  }

  if (invoice) {
    return (
      <Field label="Pay for seats">
        <InvoiceQR
          invoice={invoice.invoice}
          hash={invoice.paymentHash}
          amount={invoice.amount}
          unit="sats"
          onPaid={() => void paid()}
        />
        <button
          type="button"
          onClick={() => setInvoice(null)}
          className="mt-2 text-[11.5px] text-subtle underline"
        >
          Cancel
        </button>
      </Field>
    )
  }

  return (
    <>
      <Field
        label="Seats"
        hint={`You have used ${domain.seats_used ?? 0} of ${domain.seats_total ?? 0}. One seat per address.`}
      >
        <p className="font-mono text-[13px]">
          {domain.seats_used ?? 0} used · {domain.seats_total ?? 0} total
        </p>
      </Field>

      <Field
        label="Buy seats"
        hint={
          price
            ? `One-time payment in sats. ${price.pricePerSeatSats} sats per seat.`
            : 'One-time payment in sats.'
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-subtle">Seats to buy</span>
            <input
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              step={1}
              value={seats}
              onChange={(e) => setSeats(e.target.value)}
              aria-label="Seats to buy"
              disabled={busy}
              className={`${inputClass} w-24`}
            />
          </label>
          <div className="pb-1.5 text-[13px]">
            {total != null ? (
              <>
                <span className="text-subtle">Total </span>
                <span className="font-mono font-medium">{total} sats</span>
              </>
            ) : (
              <span className="text-subtle">
                Enter {min}–{max} seats
              </span>
            )}
          </div>
          <Button size="sm" variant="primary" onClick={() => void buy()} disabled={busy || !inRange}>
            {busy ? 'Creating invoice…' : 'Buy seats'}
          </Button>
        </div>
        {message && <p className="mt-1.5 text-[11.5px] text-subtle">{message}</p>}
      </Field>
    </>
  )
}
