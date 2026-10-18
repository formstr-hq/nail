import { getMailTiers, type MailTier } from '@/lib/api'
import type { PayOrder } from '../types'
import { fetchSeatPacks, type StorePlatform } from './api'
import { currentPlatform, initStore, type ProductKind } from './iap'

export interface Sku {
  id: string
  kind: ProductKind
}

/** The SKU for a mailbox tier on this platform, or null if the tier isn't sold here. */
export function mailSku(tier: MailTier | null | undefined, platform: StorePlatform = currentPlatform()): Sku | null {
  const id = tier?.store[platform]
  return id ? { id, kind: 'non_consumable' } : null
}

/** The SKU for a seat pack on this platform. */
export async function packSku(
  seats: number,
  platform: StorePlatform = currentPlatform(),
): Promise<Sku | null> {
  const pack = (await fetchSeatPacks()).find((p) => p.seats === seats)
  const id = pack?.[platform]
  return id ? { id, kind: 'consumable' } : null
}

/**
 * Register every SKU the app sells in one go, so the plugin can price and
 * complete any of them. (Registering is a once-only step: it must see the
 * whole catalog the first time, whichever screen asks first.)
 */
export async function initCatalog(): Promise<void> {
  const platform = currentPlatform()
  const skus: Sku[] = []
  const [tiers, packs] = await Promise.allSettled([getMailTiers(), fetchSeatPacks()])
  if (tiers.status === 'fulfilled') {
    for (const tier of tiers.value) {
      const sku = mailSku(tier, platform)
      if (sku) skus.push(sku)
    }
  }
  if (packs.status === 'fulfilled') {
    for (const pack of packs.value) {
      const id = pack[platform]
      if (id) skus.push({ id, kind: 'consumable' })
    }
  }
  await initStore(skus)
}

/** The SKU an order is for. */
export async function skuForOrder(order: PayOrder, tier: MailTier | null | undefined): Promise<Sku | null> {
  if (order.product === 'mail') return mailSku(tier)
  return 'packSeats' in order ? packSku(order.packSeats) : null
}
