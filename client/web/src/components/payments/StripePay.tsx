import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, ExternalLink } from 'lucide-react'
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js/pure'
import { isNativeApp } from '@/lib/platform'
import { checkoutUiMode } from '@/lib/payments/channels'
import { formatCurrencyMinor, formatUsd } from '@/lib/payments/money'
import { currentMailPriceUsd, currentSeatTotalUsd } from '@/lib/payments/pricing'
import { useCurrencyPreference } from '@/lib/payments/preferences'
import { pollOrderStatus } from '@/lib/payments/status'
import {
  PriceChanged,
  createCheckout,
  fetchOrderStatus,
  fetchPaymentCurrencies,
  fetchPaymentQuote,
  fetchPaymentsConfig,
  type PaymentQuote,
} from '@/lib/payments/stripe/api'
import { NATIVE_RETURN_URL, onCheckoutReturn, openCheckoutPage } from '@/lib/payments/stripe/checkoutWindow'
import type { MethodProps } from '@/lib/payments/types'
import { Confirming, StillConfirming } from './PayStatus'

type Phase =
  | { name: 'choose' }
  | { name: 'creating' }
  | { name: 'embedded'; clientSecret: string; sessionId: string }
  | { name: 'hosted'; sessionId: string }
  | { name: 'confirming' }
  | { name: 'still' }

/**
 * Card payments: the fixed USD price, a currency the buyer can pick, and one
 * button. The backend converts non-USD amounts at its own FX rate (the quote is
 * an estimate) and creates Managed Payments Checkout in the chosen currency, so
 * local payment methods are offered. This component never computes a rate.
 */
export default function StripePay({
  order,
  signer,
  tier,
  priceUsd,
  currency: lockedCurrency,
  onPriceUsdChange,
  onResult,
  onError,
}: MethodProps) {
  const [publishableKey, setPublishableKey] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [previousAmount, setPreviousAmount] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ name: 'choose' })
  const abort = useRef<AbortController | null>(null)
  const rememberedCurrency = useCurrencyPreference((s) => s.currency)
  const setCurrency = useCurrencyPreference((s) => s.setCurrency)
  const [currencies, setCurrencies] = useState<string[]>(['usd'])
  // The first panel may have already chosen the currency. Otherwise fall back
  // to the remembered card currency, or USD when the deployment dropped it.
  const currency = lockedCurrency ?? (currencies.includes(rememberedCurrency) ? rememberedCurrency : 'usd')
  const seats = 'seats' in order ? order.seats : undefined
  // The quote is kept with the inputs it was asked for, so a stale one is ignored rather than cleared.
  const quoteKey = [currency, priceUsd, order.product, seats].join(':')
  const [quoteState, setQuoteState] = useState<{ key: string; quote: PaymentQuote | null; failed: boolean }>({
    key: '',
    quote: null,
    failed: false,
  })
  const quoteFresh = quoteState.key === quoteKey
  const quote = quoteFresh ? quoteState.quote : null
  const quoteFailed = quoteFresh && quoteState.failed

  useEffect(() => {
    // The first panel already picked the currency; no need for the list.
    if (lockedCurrency) return
    let cancelled = false
    fetchPaymentCurrencies()
      .then((list) => {
        if (!cancelled && list.length > 0) setCurrencies(list)
      })
      .catch(() => {
        // Keep USD only: the picker stays hidden and card still works.
      })
    return () => {
      cancelled = true
    }
  }, [lockedCurrency])

  // The backend's FX estimate for a non-USD choice; re-asked when the price or the currency changes.
  useEffect(() => {
    if (currency === 'usd' || priceUsd == null) return
    let cancelled = false
    fetchPaymentQuote({ product: order.product, currency, seats })
      .then((next) => {
        if (!cancelled) setQuoteState({ key: quoteKey, quote: next, failed: false })
      })
      .catch(() => {
        if (!cancelled) setQuoteState({ key: quoteKey, quote: null, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [currency, priceUsd, order.product, seats, quoteKey])

  useEffect(() => {
    let cancelled = false
    void fetchPaymentsConfig().then((config) => {
      if (cancelled) return
      if (!config?.stripe.enabled || !config.stripe.publishableKey) {
        onError('Card payments are not available right now.')
        return
      }
      setPublishableKey(config.stripe.publishableKey)
      onError(null)
    })
    return () => {
      cancelled = true
    }
    // onError is a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshPrice = useCallback(async () => {
    const next =
      order.product === 'mail'
        ? await currentMailPriceUsd(order.tierId ?? tier?.id ?? '')
        : 'seats' in order
          ? await currentSeatTotalUsd(order.seats)
          : null
    if (next !== null) onPriceUsdChange?.(next)
    return next
  }, [order, tier?.id, onPriceUsdChange])

  // A workspace order can be opened before its price loaded; fetch it once.
  useEffect(() => {
    if (priceUsd != null) return
    refreshPrice().catch(() => onError('Could not load the price. Please try again.'))
    // Only when the displayed price is missing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceUsd])

  // A fresh controller per mount: StrictMode's setup/cleanup/setup cycle would
  // leave one created in a ref permanently aborted, making the post-payment
  // poll return instantly and the panel spin forever.
  useEffect(() => {
    const controller = new AbortController()
    abort.current = controller
    return () => controller.abort()
  }, [])

  const usdPrice = priceUsd != null ? formatUsd(priceUsd) : null
  // What the buyer will be charged: the USD price, or the backend's estimate in their currency.
  const price =
    currency === 'usd'
      ? usdPrice
      : quote && quote.currency === currency
        ? formatCurrencyMinor(quote.amount, quote.currency, quote.exponent)
        : null

  const settle = useCallback(
    async (sessionId: string, maxMs: number) => {
      setPhase({ name: 'confirming' })
      const signal = abort.current?.signal
      const state = await pollOrderStatus(() => fetchOrderStatus(sessionId), {
        maxMs,
        signal,
      })
      if (signal?.aborted) return
      if (state === 'paid') onResult({ status: 'paid' })
      else if (state === 'needs_attention') onResult({ status: 'needs_attention' })
      else if (state === 'expired') {
        onError('The payment session expired. Please try again.')
        setPhase({ name: 'choose' })
      } else setPhase({ name: 'still' })
    },
    [onError, onResult],
  )

  const accept = async () => {
    if (priceUsd == null || !publishableKey || price === null) return
    const native = isNativeApp()
    const mode = checkoutUiMode(native)
    setPhase({ name: 'creating' })
    onError(null)
    setNotice(null)
    try {
      const session = await createCheckout(signer, {
        product: order.product,
        expectedPriceUsd: priceUsd,
        currency,
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
      if (err instanceof PriceChanged) {
        // A buyer is never charged an amount they haven't seen: refresh it and ask again.
        if (price) setPreviousAmount(price)
        setNotice('The price was updated. Please review it before paying.')
        await refreshPrice().catch(() => {})
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

  if (!publishableKey || usdPrice === null) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={18} className="animate-spin text-gray-300" />
      </div>
    )
  }

  const fxNote = currency === 'usd' ? '' : ` · charged in ${currency.toUpperCase()} · final price may change with the exchange rate`

  return (
    <div className="flex flex-col gap-4">
      {notice && <p className="text-sm font-semibold text-amber-700">{notice}</p>}

      {!lockedCurrency && currencies.length > 1 && (
        <label className="flex items-center justify-between gap-3 text-sm text-gray-600">
          Pay in
          <select
            aria-label="Card currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="rounded-lg border border-black/10 bg-white px-2 py-1 text-ink"
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="rounded-xl border border-black/10 bg-white p-4 text-center">
        <p className="text-2xl font-bold text-ink">
          {price ?? (quoteFailed ? 'Exchange rate unavailable' : 'Converting…')}
        </p>
        <p className="mt-1 text-xs text-gray-500">
          tax included{fxNote}
          {previousAmount && previousAmount !== price ? ` · was ${previousAmount}` : ''}
        </p>
      </div>

      <button
        type="button"
        disabled={phase.name === 'creating' || price === null}
        onClick={() => void accept()}
        className={[
          'inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40',
          order.product === 'workspace'
            ? 'border border-black/10 bg-white text-ink enabled:hover:bg-gray-300'
            : 'bg-primary text-white enabled:hover:bg-primary-light',
        ].join(' ')}
      >
        {phase.name === 'creating' ? (
          <>
            <Loader2 size={15} className="animate-spin" /> Preparing checkout…
          </>
        ) : (
          <>
            {isNativeApp() && <ExternalLink size={15} />}
            Pay
          </>
        )}
      </button>
      <p className="text-center text-xs text-gray-400">
        Card purchases are sold through Stripe (Link); we never see your card. Your bank statement shows the
        amount in the currency you chose.
      </p>
    </div>
  )
}
