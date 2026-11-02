import { Suspense, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { MailTier } from '@/lib/api'
import type { Nip98Signer } from '@/lib/nip98'
import { pickDefaultMethod } from '@/lib/payments/channels'
import { availableMethods } from '@/lib/payments/methods'
import { useMethodPreference } from '@/lib/payments/preferences'
import type { MethodDefinition, PaymentChoice, PayOrder, PayResult } from '@/lib/payments/types'
import { MethodPicker } from './MethodPicker'
import { NeedsAttention } from './PayStatus'

interface PaymentSheetProps {
  order: PayOrder
  signer: Nip98Signer
  /** The mail tier being bought (mail orders only). */
  tier?: MailTier | null
  /** Fixed USD cents for the order; falls back to the tier's price. */
  priceUsd?: number | null
  /**
   * A choice made before the pay step. When supplied, the sheet skips its
   * method picker and opens straight on that method, with its currency.
   */
  choice?: PaymentChoice | null
  /** Called once the backend confirms the purchase. */
  onPaid: () => void
}

/**
 * The pay step: offers the payment methods this build has, shows the chosen
 * one, and reports when the backend says paid. The wizard and the seats panel
 * both render this and know nothing about individual methods.
 */
export function PaymentSheet({ order, signer, tier, priceUsd, choice, onPaid }: PaymentSheetProps) {
  const [methods, setMethods] = useState<MethodDefinition[] | null>(null)
  const remembered = useMethodPreference((s) => s.method)
  const remember = useMethodPreference((s) => s.setMethod)
  const [chosen, setChosen] = useState<string | null>(null)
  // The first panel already decided the method; do not ask again on this screen.
  const directMethod = choice?.methodId ?? null
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<PayResult | null>(null)
  const [displayPrice, setDisplayPrice] = useState<number | null>(null)
  const [prices, setPrices] = useState<Record<string, string | null>>({})

  useEffect(() => {
    let cancelled = false
    void availableMethods().then((list) => {
      if (!cancelled) setMethods(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedId = useMemo(() => {
    if (!methods) return null
    if (directMethod) {
      // A rail the build no longer offers falls back to its first method.
      return methods.some((m) => m.id === directMethod)
        ? directMethod
        : (methods[0]?.id ?? null)
    }
    return chosen && methods.some((m) => m.id === chosen)
      ? chosen
      : pickDefaultMethod(
          methods.map((m) => m.id),
          remembered,
        )
  }, [methods, directMethod, chosen, remembered])
  const selected = methods?.find((m) => m.id === selectedId) ?? null
  const effectivePrice = displayPrice ?? priceUsd ?? tier?.priceUsd ?? null
  const priceContext = useMemo(
    () => ({ order, tier, priceUsd: effectivePrice }),
    [order, tier, effectivePrice],
  )

  // Each method states its own amount: Bitcoin in sats, card in the chosen
  // currency. Only the picker needs those prices; a direct rail does not.
  useEffect(() => {
    if (!methods || directMethod) return
    let cancelled = false
    void Promise.all(
      methods.map(async (m) => {
        if (!m.price) return [m.id, null] as const
        try {
          return [m.id, await m.price(priceContext)] as const
        } catch {
          return [m.id, null] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) setPrices(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [methods, priceContext, directMethod])

  const handleResult = (result: PayResult) => {
    if (result.status === 'paid') onPaid()
    else setProblem(result)
  }

  if (problem?.status === 'needs_attention') return <NeedsAttention reason={problem.reason} />

  if (!methods) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 size={18} className="animate-spin text-gray-300" />
      </div>
    )
  }
  if (!selected) {
    return <p className="py-6 text-center text-sm text-gray-500">No payment method is available right now. Please try again later.</p>
  }

  const Method = selected.Component
  return (
    <div>
      {!directMethod && methods.length > 1 && (
        <MethodPicker
          methods={methods}
          selected={selected.id}
          prices={prices}
          onSelect={(id) => {
            setError(null)
            setChosen(id)
            remember(id)
          }}
        />
      )}
      {error && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-10">
            <Loader2 size={18} className="animate-spin text-gray-300" />
          </div>
        }
      >
        {/* Keyed by method so switching never reuses another method's state. */}
        <Method
          key={selected.id}
          order={order}
          signer={signer}
          tier={tier}
          priceUsd={effectivePrice}
          currency={choice?.currency}
          onPriceUsdChange={setDisplayPrice}
          onResult={handleResult}
          onError={setError}
        />
      </Suspense>
    </div>
  )
}
