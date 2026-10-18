import { Suspense, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { MailTier } from '@/lib/api'
import type { Nip98Signer } from '@/lib/nip98'
import { pickDefaultMethod } from '@/lib/payments/channels'
import { availableMethods } from '@/lib/payments/methods'
import { useMethodPreference } from '@/lib/payments/preferences'
import type { MethodDefinition, PayOrder, PayResult } from '@/lib/payments/types'
import { MethodPicker } from './MethodPicker'
import { NeedsAttention } from './PayStatus'

interface PaymentSheetProps {
  order: PayOrder
  signer: Nip98Signer
  /** The mail tier being bought (mail orders only). */
  tier?: MailTier | null
  /** Called once the backend confirms the purchase. */
  onPaid: () => void
}

/**
 * The pay step: offers the payment methods this build has, shows the chosen
 * one, and reports when the backend says paid. The wizard and the seats panel
 * both render this and know nothing about individual methods.
 */
export function PaymentSheet({ order, signer, tier, onPaid }: PaymentSheetProps) {
  const [methods, setMethods] = useState<MethodDefinition[] | null>(null)
  const remembered = useMethodPreference((s) => s.method)
  const remember = useMethodPreference((s) => s.setMethod)
  const [chosen, setChosen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<PayResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void availableMethods().then((list) => {
      if (!cancelled) setMethods(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedId = useMemo(
    () =>
      methods
        ? (chosen && methods.some((m) => m.id === chosen)
            ? chosen
            : pickDefaultMethod(
                methods.map((m) => m.id),
                remembered,
              ))
        : null,
    [methods, chosen, remembered],
  )
  const selected = methods?.find((m) => m.id === selectedId) ?? null

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
      {methods.length > 1 && (
        <MethodPicker
          methods={methods}
          selected={selected.id}
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
        <Method key={selected.id} order={order} signer={signer} tier={tier} onResult={handleResult} onError={setError} />
      </Suspense>
    </div>
  )
}
