import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { skuForOrder, initCatalog } from '@/lib/payments/store/catalog'
import { currentPlatform, getProductInfo } from '@/lib/payments/store/iap'
import { purchase, restorePurchases } from '@/lib/payments/store/flow'
import type { PurchaseIntent } from '@/lib/payments/store/intents'
import type { MethodProps } from '@/lib/payments/types'

function intentFor(order: MethodProps['order']): PurchaseIntent {
  return order.product === 'mail'
    ? { nip05: order.nip05, tierId: order.tierId, pubkey: order.pubkey }
    : { domain: order.domain }
}

/** The native store purchase: one button that opens the store's own sheet, plus Restore. */
export default function StorePay({ order, signer, tier, onResult, onError }: MethodProps) {
  const [sku, setSku] = useState<{ id: string } | null | undefined>(undefined)
  const [price, setPrice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const account = currentPlatform() === 'apple' ? 'Apple ID' : 'Google Play account'

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const found = await skuForOrder(order, tier)
        if (!found) {
          if (!cancelled) setSku(null)
          return
        }
        await initCatalog()
        if (cancelled) return
        setPrice(getProductInfo(found.id)?.price ?? null)
        setSku(found)
      } catch (err) {
        if (cancelled) return
        setSku(null)
        onError(err instanceof Error ? err.message : 'Purchases are unavailable on this device')
      }
    })()
    return () => {
      cancelled = true
    }
    // The order and tier identify the SKU; onError is a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(order), tier?.id])

  const buy = async () => {
    if (!sku) return
    setBusy(true)
    onError(null)
    try {
      const outcome = await purchase(signer, sku.id, intentFor(order))
      if (outcome.status === 'paid') onResult({ status: 'paid' })
      else if (outcome.status === 'needs_attention') onResult({ status: 'needs_attention', reason: outcome.reason })
      // cancelled: the buyer closed the store sheet, so no alert, just return here.
    } catch (err) {
      // The store may have charged already; the same token is retried, never re-bought.
      onError(
        err instanceof Error
          ? `We couldn't confirm your purchase yet. You haven't been charged twice — try again to finish. (${err.message})`
          : "We couldn't confirm your purchase yet. Try again to finish.",
      )
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    setRestoring(true)
    onError(null)
    try {
      if (await restorePurchases(signer, intentFor(order))) onResult({ status: 'paid' })
      else onError('There was nothing to restore for this account.')
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Restoring purchases failed')
    } finally {
      setRestoring(false)
    }
  }

  if (sku === undefined) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={18} className="animate-spin text-gray-300" />
      </div>
    )
  }
  if (sku === null) {
    return <p className="py-4 text-center text-sm text-gray-500">This purchase isn't available on this device.</p>
  }

  const label = order.product === 'mail' ? `Mail · ${order.nip05}` : `Seats · ${order.domain}`
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-xl border border-black/10 bg-white p-4">
        <span className="text-sm font-semibold text-ink">{label}</span>
        <span className="text-lg font-bold text-ink">{price ?? '—'}</span>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void buy()}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white transition-all enabled:hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : null}
        {price ? `Buy for ${price}` : 'Buy'}
      </button>
      <button
        type="button"
        disabled={restoring}
        onClick={() => void restore()}
        className="text-center text-sm font-semibold text-primary underline disabled:opacity-40"
      >
        {restoring ? 'Restoring…' : 'Restore purchases'}
      </button>
      <p className="text-center text-xs text-gray-400">
        Charged to your {account}. A one-time purchase — no subscription.
      </p>
    </div>
  )
}
