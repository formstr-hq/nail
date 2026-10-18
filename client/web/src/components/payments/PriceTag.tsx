import { Suspense, lazy } from 'react'
import type { MailTier } from '@/lib/api'

/** What a price is being shown for. */
export type PriceSubject = { kind: 'mail'; tier: MailTier } | { kind: 'seats'; seats: number }

// Chosen at BUILD time so the store bundle never contains the open-build price
// code (which reads sats and card quotes) and the open bundle never contains
// the store one. See lib/payments/methods.ts for why this must be a constant.
const Impl =
  import.meta.env.VITE_STORE_BUILD === '1'
    ? lazy(() => import('./StorePrice'))
    : lazy(() => import('./OpenPrice'))

/** The price of something, in whatever form this build is allowed to show. */
export function PriceTag({ subject }: { subject: PriceSubject }) {
  return (
    <Suspense fallback={<span className="text-gray-300">…</span>}>
      <Impl subject={subject} />
    </Suspense>
  )
}
