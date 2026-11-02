import { useEffect, useState } from 'react'
import type { ActiveSigner } from '@formstr/signer'
import { Button } from '@/app/components/ui/Button'
import { Field, inputClass } from '@/app/components/settings/Field'
import InvoiceQR from '@/components/InvoiceQR'
import {
  createSeatCardCheckout,
  createSeatInvoice,
  fetchPaymentCurrencies,
  fetchSeatCardQuote,
  fetchSeatPrice,
  type CardQuote,
  type SeatInvoice,
  type SeatPrice,
  type WorkspaceDomain,
} from '@/app/lib/api/workspace'

/** Clamp a raw input string to an optional non-negative integer. */
function parseInt0(value: string): number | null {
  const n = Number(value.trim())
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** Pay in Bitcoin over Lightning. Pinned first in the currency list. */
const SATS = 'sats'
/** Card currency when nothing is saved yet. */
const DEFAULT_CURRENCY = 'usd'
const CURRENCY_KEY = 'formstr.payCurrency'

function loadSavedCurrency(): string {
  try {
    return localStorage.getItem(CURRENCY_KEY) || DEFAULT_CURRENCY
  } catch {
    return DEFAULT_CURRENCY
  }
}

function saveCurrency(currency: string) {
  try {
    localStorage.setItem(CURRENCY_KEY, currency)
  } catch {
    // Storage unavailable (private mode): the choice just isn't remembered.
  }
}

/** `1234 minor` in `EUR` with `exponent` digits, e.g. 1234 / 2 → "12.34 EUR". */
function formatMinor(amount: number, exponent: number, currency: string): string {
  return `${(amount / 10 ** exponent).toFixed(exponent)} ${currency.toUpperCase()}`
}

/**
 * Billing: buy seats for the workspace.
 *
 * Pricing is flat — one price per seat, no tiers — so the buyer chooses a
 * quantity rather than picking a pack. The buyer also chooses how to pay: sats
 * over Lightning, or a card in a presentment currency (for example EUR, so local
 * methods can show). The server prices every option; this panel only reads the
 * prices to show a live total and validates the input.
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
  const [cardCurrencies, setCardCurrencies] = useState<string[]>([DEFAULT_CURRENCY])
  const [currency, setCurrency] = useState<string>(loadSavedCurrency)
  const [quoted, setQuoted] = useState<{ key: string; quote: CardQuote } | null>(null)
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
    fetchPaymentCurrencies()
      .then((codes) => {
        setCardCurrencies(codes)
        // A saved choice the deployment no longer offers falls back to USD.
        setCurrency((current) => (current === SATS || codes.includes(current) ? current : DEFAULT_CURRENCY))
      })
      .catch(() => {
        // Keep USD only; Lightning stays available.
      })
  }, [])

  const min = price?.minSeats ?? 1
  const max = price?.maxSeats ?? 1000
  const parsed = parseInt0(seats)
  const inRange = parsed != null && parsed >= min && parsed <= max
  const isSats = currency === SATS
  const satsTotal =
    price && parsed != null && inRange ? price.pricePerSeatSats * parsed : null

  // Card price comes from the backend's quote for the chosen currency and seats.
  // The quote is keyed so a result for an older currency or seat count is never shown.
  const quoteKey = `${currency}:${parsed}`
  const quote = !isSats && inRange && quoted?.key === quoteKey ? quoted.quote : null
  useEffect(() => {
    if (isSats || !inRange || parsed == null) return
    let cancelled = false
    fetchSeatCardQuote(parsed, currency)
      .then((q) => {
        if (!cancelled) setQuoted({ key: quoteKey, quote: q })
      })
      .catch((e) => {
        if (!cancelled) setMessage(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [isSats, currency, parsed, inRange, quoteKey])

  function chooseCurrency(next: string) {
    setCurrency(next)
    saveCurrency(next)
    setMessage(null)
  }

  async function buy() {
    if (!inRange || parsed == null) return
    setBusy(true)
    setMessage(null)
    try {
      if (isSats) {
        setInvoice(await createSeatInvoice(active, domain.domain, parsed))
      } else {
        const checkout = await createSeatCardCheckout(active, domain.domain, parsed, currency)
        // Leaves the app for Stripe's hosted page; the seats are added by the webhook.
        window.location.assign(checkout.url)
      }
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
          isSats
            ? price
              ? `One-time payment in sats. ${price.pricePerSeatSats} sats per seat.`
              : 'One-time payment in sats.'
            : 'One-time card payment. Pay in your own currency where supported.'
        }
      >
        <div className="mb-2 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-subtle">Pay in</span>
            <select
              value={currency}
              onChange={(e) => chooseCurrency(e.target.value)}
              aria-label="Pay in"
              disabled={busy}
              className={`${inputClass} w-40`}
            >
              <option value={SATS}>Bitcoin (sats)</option>
              {cardCurrencies.map((code) => (
                <option key={code} value={code}>
                  {code.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-2 text-[11.5px] text-subtle">
            {isSats ? 'Lightning invoice' : 'Card (Stripe Checkout)'}
          </span>
        </div>

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
            {!inRange ? (
              <span className="text-subtle">
                Enter {min}–{max} seats
              </span>
            ) : isSats ? (
              satsTotal != null && (
                <>
                  <span className="text-subtle">Total </span>
                  <span className="font-mono font-medium">{satsTotal} sats</span>
                </>
              )
            ) : quote ? (
              <>
                <span className="text-subtle">Total </span>
                <span className="font-mono font-medium">
                  {formatMinor(quote.amount, quote.exponent, quote.currency)}
                </span>
                {quote.estimate && (
                  <span className="block text-[11px] text-subtle">
                    Final price may change with the exchange rate.
                  </span>
                )}
              </>
            ) : (
              <span className="text-subtle">Loading price…</span>
            )}
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void buy()}
            disabled={busy || !inRange || (!isSats && !quote)}
          >
            {busy ? (isSats ? 'Creating invoice…' : 'Opening checkout…') : isSats ? 'Create invoice' : 'Pay by card'}
          </Button>
        </div>
        {message && <p className="mt-1.5 text-[11.5px] text-subtle">{message}</p>}
      </Field>
    </>
  )
}
