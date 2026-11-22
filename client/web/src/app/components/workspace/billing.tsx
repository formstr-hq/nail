import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import type { ActiveSigner } from '@formstr/signer'
import { Button } from '@/app/components/ui/Button'
import { Field, inputClass } from '@/app/components/settings/Field'
import { PaymentSheet } from '@/components/payments/PaymentSheet'
import { PriceTag } from '@/components/payments/PriceTag'
import { fetchSeatLimits, type SeatLimits } from '@/lib/payments/seatLimits'
import type { PayOrder } from '@/lib/payments/types'
import { withSignerTimeout } from '@/app/lib/nostr/signer'
import type { SeatView, WorkspaceDomain } from '@/app/lib/api/workspace'

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
 * prices and their bounds come from the server (and the store); this panel
 * only collects the quantity and hands the order to the payment sheet.
 */
export function SeatsPanel({
  active,
  domain,
  seatPool,
  onPurchased,
}: {
  active: ActiveSigner
  domain: WorkspaceDomain
  /** The owner's shared pool; `domain_used` is this domain's own address count. */
  seatPool: SeatView
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
  const totalUsd =
    parsed != null && limits?.seatPriceUsd ? limits.seatPriceUsd * parsed : null

  async function paid() {
    setPaying(null)
    await onPurchased()
  }

  if (paying) {
    return (
      <Field label="Pay for seats">
        <PaymentSheet order={paying} signer={signer} priceUsd={totalUsd} onPaid={() => void paid()} />
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
        hint="One seat per address. Your seats are shared across every domain you own, so freeing an address here makes its seat available on any of your other domains."
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[13px]">
          <span>{seatPool.used} used</span>
          <span className="text-subtle">·</span>
          <span>{seatPool.total} total</span>
          <span className="text-subtle">·</span>
          <span className={seatPool.available > 0 ? 'text-foreground' : 'text-destructive'}>
            {seatPool.available} available
          </span>
        </div>
        <p className="mt-1 text-[11px] text-subtle">
          This domain uses {seatPool.domain_used ?? domain.seats_used ?? 0} of your
          shared seats. Deleting a domain does not delete its purchased seats.
        </p>
      </Field>

      {StoreSeatPacks ? (
        <Field label="Buy seats" hint="One-time purchase. Seats are added to your shared pool for all your domains and are valid for 1 year.">
          <Suspense fallback={null}>
            <StoreSeatPacks onPick={(packSeats) => setPaying({ product: 'workspace', domain: domain.domain, packSeats })} />
          </Suspense>
        </Field>
      ) : (
        <Field label="Buy seats" hint="Pay with Bitcoin or your local currency. Seats go into your shared pool and are valid for 1 year.">
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
                    <PriceTag subject={{ kind: 'seats', seats: parsed, priceUsd: totalUsd }} />
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
        </Field>
      )}
    </>
  )
}
