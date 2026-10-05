import { useEffect, useState } from 'react'
import type { ActiveSigner } from '@formstr/signer'
import { Button } from '@/app/components/ui/Button'
import { CheckIcon } from '@/app/components/ui/icons'
import { Field } from '@/app/components/settings/Field'
import InvoiceQR from '@/components/InvoiceQR'
import {
  createSeatInvoice,
  fetchSeatPacks,
  type SeatInvoice,
  type SeatPack,
  type WorkspaceDomain,
} from '@/app/lib/api/workspace'

/**
 * Billing: buy seats for the workspace. Kept on its own tab so the setup
 * screen is not also a shop. Payment handoff reuses the shared invoice UI
 * (QR, wallet deep-link, countdown, payment socket).
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
  const [packs, setPacks] = useState<SeatPack[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [invoice, setInvoice] = useState<SeatInvoice | null>(null)

  useEffect(() => {
    fetchSeatPacks()
      .then(setPacks)
      .catch(() => {
        // Non-fatal: packs are a convenience; buying still works once they load.
      })
  }, [])

  async function buy(seats: number) {
    setBusy(seats)
    setMessage(null)
    try {
      setInvoice(await createSeatInvoice(active, domain.domain, seats))
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
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
      <Field label="Seats" hint="One seat per address. You have used these so far.">
        <p className="font-mono text-[13px]">
          {domain.seats_used ?? 0} used · {domain.seats_total ?? 0} total
        </p>
      </Field>

      <Field
        label="Buy seats"
        hint="Volume discounts apply automatically; one-time payment in sats."
      >
        <div className="flex flex-wrap gap-2">
          {packs.map((pack) => (
            <Button
              key={pack.seats}
              size="sm"
              variant="secondary"
              onClick={() => void buy(pack.seats)}
              disabled={busy != null}
            >
              <CheckIcon className="h-3.5 w-3.5" />
              {pack.seats} seats — {pack.totalSats} sats
              {pack.discountPercent > 0 ? ` (${pack.discountPercent}% off)` : ''}
            </Button>
          ))}
        </div>
        {message && <p className="mt-1.5 text-[11.5px] text-subtle">{message}</p>}
      </Field>
    </>
  )
}
