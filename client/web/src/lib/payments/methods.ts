// The payment methods a build offers, composed at BUILD time.
//
// Store builds (Play / App Store) must contain no Lightning and no card code:
// no module, no copy, no endpoints. The only reliable way to guarantee that is
// for the bundler to never see the import, so the choice is made on the
// build-time constant `import.meta.env.VITE_STORE_BUILD` and each method is a
// dynamic import inside the branch that wants it. A runtime switch would keep
// every method's code in the bundle.
//
// This file and the picker/sheet around it are the only shared code that knows
// methods exist; it must not name a payment rail outside its own branch.
import { lazy } from 'react'
import { formatSats, formatUsd } from './money'
import type { MethodDefinition } from './types'

const OPEN_BUILD_METHODS = (): MethodDefinition[] => [
  {
    id: 'lightning',
    label: 'Pay with Bitcoin',
    price: async ({ order, tier }) => {
      const { orderSats } = await import('./lightning/api')
      const sats = await orderSats(order, tier)
      return sats ? formatSats(sats.amount, sats.unit) : null
    },
    Component: lazy(() => import('@/components/payments/LightningPay')),
  },
  {
    id: 'stripe',
    label: 'Pay in your local currency',
    price: ({ priceUsd }) => (priceUsd == null ? null : formatUsd(priceUsd)),
    available: async () => {
      const api = await import('./stripe/api')
      const config = await api.fetchPaymentsConfig()
      return Boolean(config?.stripe.enabled && config.stripe.publishableKey)
    },
    Component: lazy(() => import('@/components/payments/StripePay')),
  },
]

const STORE_BUILD_METHODS = (): MethodDefinition[] => [
  {
    id: 'store',
    label: 'Pay in your app store',
    Component: lazy(() => import('@/components/payments/StorePay')),
  },
]

/** Every method this build can offer, in display order (the first is the default). */
export function buildMethods(): MethodDefinition[] {
  return import.meta.env.VITE_STORE_BUILD === '1' ? STORE_BUILD_METHODS() : OPEN_BUILD_METHODS()
}

/** The methods that are usable right now. Never rejects: a failed probe hides that method. */
export async function availableMethods(
  methods: MethodDefinition[] = buildMethods(),
): Promise<MethodDefinition[]> {
  const checks = await Promise.all(
    methods.map(async (m) => {
      if (!m.available) return true
      try {
        return await m.available()
      } catch {
        return false
      }
    }),
  )
  return methods.filter((_, i) => checks[i])
}
