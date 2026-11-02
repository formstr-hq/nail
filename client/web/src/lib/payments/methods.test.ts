import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeTier } from '@/lib/api'
import { formatSats } from './money'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function load(storeBuild: boolean) {
  vi.resetModules()
  vi.stubEnv('VITE_STORE_BUILD', storeBuild ? '1' : '')
  return import('./methods')
}

describe('channel matrix', () => {
  it('open builds (web, direct APK) offer Lightning first, then card', async () => {
    const { buildMethods } = await load(false)
    expect(buildMethods().map((m) => m.id)).toEqual(['lightning', 'stripe'])
  })

  it('store builds offer in-app purchase only', async () => {
    const { buildMethods } = await load(true)
    expect(buildMethods().map((m) => m.id)).toEqual(['store'])
  })

  it("prices Bitcoin in sats and card in USD", async () => {
    const { buildMethods } = await load(false)
    const [lightning, stripe] = buildMethods()
    const order = { product: 'mail', pubkey: 'p', nip05: 'a@b', tierId: 'base' } as const
    const tier = normalizeTier({ id: 'base', name: 'Mail', priceSats: 1000, unit: 'sats' })!

    expect(await lightning.price?.({ order, tier, priceUsd: 500 })).toBe(formatSats(1000))
    expect(await stripe.price?.({ order, tier, priceUsd: 500 })).toBe('$5.00')
  })
})

describe('availableMethods', () => {
  it('drops a method whose probe says no, or throws', async () => {
    const { availableMethods } = await load(false)
    const fake = (id: string, available?: () => Promise<boolean>) => ({ id, label: id, available, Component: () => null })
    const out = await availableMethods([
      fake('a'),
      fake('b', async () => false),
      fake('c', async () => {
        throw new Error('network')
      }),
      fake('d', async () => true),
    ])
    expect(out.map((m) => m.id)).toEqual(['a', 'd'])
  })
})
