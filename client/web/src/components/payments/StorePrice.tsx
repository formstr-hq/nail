import { useEffect, useState } from 'react'
import { initCatalog, mailSku } from '@/lib/payments/store/catalog'
import { getProductInfo } from '@/lib/payments/store/iap'
import type { PriceSubject } from './PriceTag'

/** Store builds: the store's own localised price string, never our number. */
export default function StorePrice({ subject }: { subject: PriceSubject }) {
  const [price, setPrice] = useState<string | null>(null)
  const tier = subject.kind === 'mail' ? subject.tier : null
  useEffect(() => {
    if (!tier) return
    let cancelled = false
    void (async () => {
      const sku = mailSku(tier)
      if (!sku) return
      try {
        await initCatalog()
        if (!cancelled) setPrice(getProductInfo(sku.id)?.price ?? null)
      } catch {
        // No price to show; the pay step reports the problem.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tier])
  return <span>{price ?? '…'}</span>
}
