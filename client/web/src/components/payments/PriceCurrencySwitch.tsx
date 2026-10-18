import { Suspense, lazy } from 'react'

// Only open builds have anything to switch; store prices are the store's own.
const Impl =
  import.meta.env.VITE_STORE_BUILD === '1' ? null : lazy(() => import('./OpenCurrencySwitch'))

export function PriceCurrencySwitch() {
  if (!Impl) return null
  return (
    <Suspense fallback={null}>
      <Impl />
    </Suspense>
  )
}
