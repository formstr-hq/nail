import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, ExternalLink } from 'lucide-react'
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js/pure'
import { isNativeApp } from '@/lib/platform'
import { checkoutUiMode } from '@/lib/payments/channels'
import { pollOrderStatus } from '@/lib/payments/status'
import {
  CardUnavailable,
  QuoteConflict,
  createCheckout,
  fetchCurrencies,
  fetchOrderStatus,
  fetchPaymentsConfig,
  requestQuote,
  type CurrencyInfo,
  type Quote,
  type QuoteRequest,
} from '@/lib/payments/stripe/api'
import { NATIVE_RETURN_URL, onCheckoutReturn, openCheckoutPage } from '@/lib/payments/stripe/checkoutWindow'
import { formatMoney, resolveDisplayCurrency } from '@/lib/payments/stripe/money'
import { useCurrencyPreference } from '@/lib/payments/stripe/preferences'
import type { MethodProps } from '@/lib/payments/types'
import { Confirming, StillConfirming } from './PayStatus'
import { CurrencySelect } from './CurrencySelect'

type Phase =
  | { name: 'choose' }
  | { name: 'creating' }
  | { name: 'embedded'; clientSecret: string; sessionId: string }
  | { name: 'hosted'; sessionId: string }
  | { name: 'confirming' }
  | { name: 'still' }

function quoteRequestFor(order: MethodProps['order'], tierId: string | undefined, currency: string): QuoteRequest | null {
  if (order.product === 'mail') return { product: 'mail', currency, tierId: order.tierId ?? tierId ?? '' }
  if ('seats' in order) return { product: 'workspace', currency, seats: order.seats }
  return null
}

/** Mm:ss for a countdown. */
function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Card payments: pick a currency, accept a quoted price, pay in Stripe Checkout. */
export default function StripePay({ order, signer, onResult, onError }: MethodProps) {
  const [currencies, setCurrencies] = useState<CurrencyInfo[] | null>(null)
  const [publishableKey, setPublishableKey] = useState<string | null>(null)
  const stored = useCurrencyPreference((s) => s.currency)
  const setStored = useCurrencyPreference((s) => s.setCurrency)
  const [currency, setCurrency] = useState<string | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [previousAmount, setPreviousAmount] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [phase, setPhase] = useState<Phase>({ name: 'choose' })
  const abort = useRef(new AbortController())

  // Config and currencies once.
  useEffect(() => {
    let cancelled = false
    void Promise.all([fetchPaymentsConfig(), fetchCurrencies()]).then(([config, list]) => {
      if (cancelled) return
      if (!config?.stripe.enabled || !list) {
        onError('Card payments are not available right now.')
        return
      }
      setPublishableKey(config.stripe.publishableKey)
      setCurrencies(list.currencies)
      // "sats" is a display-only choice; the card needs a real currency.
      const resolved = resolveDisplayCurrency(stored === 'sats' ? null : stored, list.currencies, navigator.language)
      setCurrency(resolved === 'sats' ? (list.currencies[0]?.code ?? null) : resolved)
    })
    return () => {
      cancelled = true
    }
    // Only on mount: later preference changes must not reset the buyer's pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const request = useMemo(
    () => (currency ? quoteRequestFor(order, undefined, currency) : null),
    [order, currency],
  )

  // A fresh quote whenever the currency changes, the old one lapsed, or checkout refused it.
  useEffect(() => {
    if (!request) return
    let cancelled = false
    setQuote(null)
    requestQuote(request)
      .then((q) => {
        if (cancelled) return
        setQuote(q)
        setNow(Date.now())
        onError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        onError(
          err instanceof CardUnavailable
            ? 'Card prices are temporarily unavailable. You can pay with Lightning instead.'
            : err instanceof Error
              ? err.message
              : 'Could not get a price',
        )
      })
    return () => {
      cancelled = true
    }
    // onError is a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, refreshNonce])

  // Countdown, and re-quote when the offer lapses while the buyer is still deciding.
  useEffect(() => {
    if (phase.name !== 'choose' || !quote) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [phase.name, quote])
  const remaining = quote ? new Date(quote.expiresAt).getTime() - now : 0
  useEffect(() => {
    if (phase.name === 'choose' && quote && remaining <= 0) setRefreshNonce((n) => n + 1)
  }, [phase.name, quote, remaining])

  useEffect(() => () => abort.current.abort(), [])

  const info = currencies?.find((c) => c.code === currency)
  const price = quote && info ? formatMoney(quote.amountMinor, quote.currency, quote.exponent) : null

  const settle = useCallback(
    async (sessionId: string, maxMs: number) => {
      setPhase({ name: 'confirming' })
      const state = await pollOrderStatus(() => fetchOrderStatus(sessionId), {
        maxMs,
        signal: abort.current.signal,
      })
      if (abort.current.signal.aborted) return
      if (state === 'paid') onResult({ status: 'paid' })
      else if (state === 'needs_attention') onResult({ status: 'needs_attention' })
      else if (state === 'expired') {
        onError('The payment session expired. Please try again.')
        setPhase({ name: 'choose' })
        setRefreshNonce((n) => n + 1)
      } else setPhase({ name: 'still' })
    },
    [onError, onResult],
  )

  const accept = async () => {
    if (!quote || !publishableKey) return
    const native = isNativeApp()
    const mode = checkoutUiMode(native)
    setPhase({ name: 'creating' })
    onError(null)
    setNotice(null)
    try {
      const session = await createCheckout(signer, {
        product: order.product,
        quoteToken: quote.quoteToken,
        uiMode: mode,
        ...(order.product === 'mail'
          ? { tierId: order.tierId, nip05: order.nip05 }
          : 'seats' in order
            ? { domain: order.domain, seats: order.seats }
            : {}),
        ...(mode === 'hosted' ? { returnUrl: native ? NATIVE_RETURN_URL : window.location.href } : {}),
      })
      if (mode === 'embedded' && session.clientSecret) {
        setPhase({ name: 'embedded', clientSecret: session.clientSecret, sessionId: session.sessionId })
      } else if (session.url) {
        setPhase({ name: 'hosted', sessionId: session.sessionId })
        await openCheckoutPage(session.url)
        // Hosted checkout can take as long as the session lives.
        void settle(session.sessionId, 30 * 60_000)
      } else {
        throw new Error('Checkout did not return a payment page')
      }
    } catch (err) {
      setPhase({ name: 'choose' })
      if (err instanceof QuoteConflict) {
        // A buyer is never charged an amount they haven't seen: show the new one and ask again.
        if (price) setPreviousAmount(price)
        setNotice('The price was updated. Please review it before paying.')
        setRefreshNonce((n) => n + 1)
      } else {
        onError(err instanceof Error ? err.message : 'Could not start the payment')
      }
    }
  }

  // Wake the poll sooner when the buyer returns from the hosted page.
  useEffect(() => {
    if (phase.name !== 'hosted') return
    return onCheckoutReturn(() => setPhase({ name: 'confirming' }))
  }, [phase.name])

  const stripePromise = useMemo(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    [publishableKey],
  )

  if (phase.name === 'embedded' && stripePromise) {
    return (
      <EmbeddedCheckoutProvider
        stripe={stripePromise}
        options={{
          clientSecret: phase.clientSecret,
          onComplete: () => void settle(phase.sessionId, 120_000),
        }}
      >
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    )
  }
  if (phase.name === 'confirming' || phase.name === 'hosted') {
    return phase.name === 'hosted' ? (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <Loader2 size={20} className="animate-spin text-gray-400" />
        <p className="text-sm font-semibold text-ink">Complete your payment in the browser</p>
        <p className="text-xs text-gray-500">We'll bring you back here when it's done.</p>
      </div>
    ) : (
      <Confirming />
    )
  }
  if (phase.name === 'still') return <StillConfirming />

  if (!currencies || !currency) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={18} className="animate-spin text-gray-300" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="card-currency" className="text-sm text-gray-600">
          Pay in
        </label>
        <CurrencySelect
          id="card-currency"
          currencies={currencies}
          value={currency}
          onChange={(code) => {
            setPreviousAmount(null)
            setNotice(null)
            setCurrency(code)
            setStored(code)
          }}
        />
      </div>

      {notice && <p className="text-sm font-semibold text-amber-700">{notice}</p>}

      <div className="rounded-xl border border-black/10 bg-white p-4 text-center">
        {price ? (
          <>
            <p className="text-2xl font-bold text-ink">{price}</p>
            <p className="mt-1 text-xs text-gray-500">
              plus applicable tax · valid for {clock(remaining)}
              {previousAmount && previousAmount !== price ? ` · was ${previousAmount}` : ''}
            </p>
          </>
        ) : (
          <Loader2 size={18} className="mx-auto animate-spin text-gray-300" />
        )}
      </div>

      <button
        type="button"
        disabled={!price || phase.name === 'creating'}
        onClick={() => void accept()}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white transition-all enabled:hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-40"
      >
        {phase.name === 'creating' ? (
          <>
            <Loader2 size={15} className="animate-spin" /> Preparing checkout…
          </>
        ) : (
          <>
            {isNativeApp() && <ExternalLink size={15} />}
            {price ? `Accept and pay ${price}` : 'Accept and pay'}
          </>
        )}
      </button>
      <p className="text-center text-xs text-gray-400">
        Card purchases are sold through Stripe (Link); we never see your card. Tax is calculated at checkout.
      </p>
    </div>
  )
}
