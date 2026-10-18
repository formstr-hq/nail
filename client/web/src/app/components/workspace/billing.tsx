import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import type { ActiveSigner } from '@formstr/signer'
import { Button } from '@/app/components/ui/Button'
import { Field, inputClass } from '@/app/components/settings/Field'
import { PaymentSheet } from '@/components/payments/PaymentSheet'
import { PriceTag } from '@/components/payments/PriceTag'
import { PriceCurrencySwitch } from '@/components/payments/PriceCurrencySwitch'
import { fetchSeatLimits, type SeatLimits } from '@/lib/payments/seatLimits'
import type { PayOrder } from '@/lib/payments/types'
import { withSignerTimeout } from '@/app/lib/nostr/signer'
import type { WorkspaceDomain } from '@/app/lib/api/workspace'

// Store builds sell fixed packs, not a free quantity. Chosen at build time so
// the open build never contains the pack picker (and vice versa).
const StoreSeatPacks =
  import.meta.env.VITE_STORE_BUILD === '1' ? lazy(() => import('@/components/payments/StoreSeatPacks')) : null

/** Clamp a raw input string to an optional non-negative integer. */
function parseInt0(value: string): number | null {
  const n = Number(value.trim())
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * Billing: buy seats for the workspace.
 *
 * Open builds let the buyer choose any quantity and pay with whichever method
 * the build offers; store builds sell fixed packs through the app store. The
 * prices, their bounds and the currencies come from the server (and the store);
 * this panel only collects the quantity and hands the order to the payment
 * sheet.
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
  const [limits, setLimits] = useState<SeatLimits | null>(null)
  const [seats, setSeats] = useState('1')
  const [paying, setPaying] = useState<PayOrder | null>(null)

  useEffect(() => {
    if (StoreSeatPacks) return
    void fetchSeatLimits().then(setLimits)
  }, [])

  // The signer's own calls can hang on a locked remote signer: bound them.
  const signer = useMemo(
    () => ({ signEvent: (event: Parameters<ActiveSigner['signEvent']>[0]) => withSignerTimeout('signEvent', () => active.signEvent(event)) }),
    [active],
  )

  const min = limits?.minSeats ?? 1
  const max = limits?.maxSeats ?? 1000
  const parsed = parseInt0(seats)
  const inRange = parsed != null && parsed >= min && parsed <= max

  async function paid() {
    setPaying(null)
    await onPurchased()
  }

  if (paying) {
    return (
      <Field label="Pay for seats">
        <PaymentSheet order={paying} signer={signer} onPaid={() => void paid()} />
        <button
          type="button"
          onClick={() => setPaying(null)}
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

      {StoreSeatPacks ? (
        <Field label="Buy seats" hint="One-time purchase. Buy as many packs as you need.">
          <Suspense fallback={null}>
            <StoreSeatPacks onPick={(packSeats) => setPaying({ product: 'workspace', domain: domain.domain, packSeats })} />
          </Suspense>
        </Field>
      ) : (
        <Field label="Buy seats" hint="One-time payment.">
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
                className={`${inputClass} w-24`}
              />
            </label>
            <div className="pb-1.5 text-[13px]">
              {inRange ? (
                <>
                  <span className="text-subtle">Total </span>
                  <span className="font-mono font-medium">
                    <PriceTag subject={{ kind: 'seats', seats: parsed }} />
                  </span>
                </>
              ) : (
                <span className="text-subtle">
                  Enter {min}–{max} seats
                </span>
              )}
            </div>
            <Button
              size="sm"
              variant="primary"
              disabled={!inRange}
              onClick={() => inRange && setPaying({ product: 'workspace', domain: domain.domain, seats: parsed })}
            >
              Buy seats
            </Button>
          </div>
          <div className="mt-2">
            <PriceCurrencySwitch />
          </div>
        </Field>
      )}
    </>
  )
}
