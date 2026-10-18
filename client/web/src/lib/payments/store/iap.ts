// A thin wrapper over the native purchase plugin (cordova-plugin-purchase,
// which exposes `window.CdvPurchase` inside the Capacitor shell). Everything
// the rest of the app knows about purchasing is this file's surface: it
// returns normalised receipts and never exposes the plugin's own types.
//
// Only imported in store builds (lib/payments/methods.ts), so the web bundle
// and the direct APK never contain it.
import { Capacitor } from '@capacitor/core'
import type { StorePlatform, StoreReceiptBody } from './api'

/** A purchase the store has charged for, waiting for our backend to confirm it. */
export interface PendingPurchase {
  platform: StorePlatform
  productId: string
  receipt: StoreReceiptBody
  /** Tell the store we're done. Consumables are only finished after verify succeeds. */
  finish(): Promise<void>
}

export type ProductKind = 'non_consumable' | 'consumable'

export interface StoreProductInfo {
  id: string
  /** The store's own localised price string, e.g. "€4,99". Never our number. */
  price: string
}

// The slice of the plugin we use. Declared here so nothing else imports its types.
interface CdvTransaction {
  state?: string
  transactionId?: string
  purchaseId?: string
  products?: Array<{ id: string }>
  nativePurchase?: { purchaseToken?: string; orderId?: string }
  finish(): Promise<void>
}
interface CdvOffer {
  pricingPhases?: Array<{ price?: string }>
}
interface CdvProduct {
  id: string
  getOffer(): CdvOffer | undefined
}
interface CdvStore {
  register(products: Array<{ id: string; type: string; platform: string }>): void
  initialize(platforms: string[]): Promise<unknown[]>
  get(id: string, platform?: string): CdvProduct | undefined
  order(offer: CdvOffer): Promise<{ code?: number; message?: string } | undefined>
  restorePurchases(): Promise<unknown>
  when(): {
    approved(cb: (tx: CdvTransaction) => void): unknown
  }
  localTransactions: CdvTransaction[]
}
interface CdvGlobal {
  store: CdvStore
  ProductType: { CONSUMABLE: string; NON_CONSUMABLE: string }
  Platform: { APPLE_APPSTORE: string; GOOGLE_PLAY: string }
  ErrorCode: { PAYMENT_CANCELLED: number }
}

function plugin(): CdvGlobal {
  const cdv = (window as unknown as { CdvPurchase?: CdvGlobal }).CdvPurchase
  if (!cdv) throw new Error('In-app purchases are not available on this device')
  return cdv
}

export function currentPlatform(): StorePlatform {
  return Capacitor.getPlatform() === 'ios' ? 'apple' : 'google'
}

function platformId(cdv: CdvGlobal): string {
  return currentPlatform() === 'apple' ? cdv.Platform.APPLE_APPSTORE : cdv.Platform.GOOGLE_PLAY
}

function toPending(tx: CdvTransaction, productId: string): PendingPurchase {
  const platform = currentPlatform()
  return {
    platform,
    productId,
    receipt:
      platform === 'apple'
        ? { transactionId: tx.transactionId ?? tx.purchaseId }
        : {
            purchaseToken: tx.nativePurchase?.purchaseToken ?? tx.purchaseId,
            orderId: tx.nativePurchase?.orderId,
          },
    finish: () => tx.finish(),
  }
}

/** Approved purchases that nobody has claimed yet (a new one, or one left over from a previous run). */
const approved = new Map<string, PendingPurchase>()
const waiters = new Map<string, (p: PendingPurchase) => void>()
let initialised: Promise<void> | null = null

/** Register the catalog and start listening. Safe to call repeatedly. */
export function initStore(skus: ReadonlyArray<{ id: string; kind: ProductKind }>): Promise<void> {
  initialised ??= (async () => {
    const cdv = plugin()
    const platform = platformId(cdv)
    cdv.store.register(
      skus.map((s) => ({
        id: s.id,
        type: s.kind === 'consumable' ? cdv.ProductType.CONSUMABLE : cdv.ProductType.NON_CONSUMABLE,
        platform,
      })),
    )
    cdv.store.when().approved((tx) => {
      const productId = tx.products?.[0]?.id
      if (!productId) return
      const purchase = toPending(tx, productId)
      const waiter = waiters.get(productId)
      if (waiter) {
        waiters.delete(productId)
        waiter(purchase)
      } else {
        approved.set(productId, purchase)
      }
    })
    await cdv.store.initialize([platform])
  })().catch((err) => {
    initialised = null
    throw err
  })
  return initialised
}

export function getProductInfo(productId: string): StoreProductInfo | null {
  const cdv = plugin()
  const offer = cdv.store.get(productId, platformId(cdv))?.getOffer()
  const price = offer?.pricingPhases?.[0]?.price
  return price ? { id: productId, price } : null
}

/** Open the store's own payment sheet. Resolves null if the buyer cancelled. */
export async function buy(productId: string): Promise<PendingPurchase | null> {
  const cdv = plugin()
  const offer = cdv.store.get(productId, platformId(cdv))?.getOffer()
  if (!offer) throw new Error('This product is not available right now')

  // A purchase left unfinished from earlier is handed back, not charged twice.
  const leftover = approved.get(productId)
  if (leftover) {
    approved.delete(productId)
    return leftover
  }

  const done = new Promise<PendingPurchase>((resolve) => waiters.set(productId, resolve))
  const error = await cdv.store.order(offer)
  if (error) {
    waiters.delete(productId)
    if (error.code === cdv.ErrorCode.PAYMENT_CANCELLED) return null
    throw new Error(error.message || 'The purchase could not be completed')
  }
  return done
}

/** Re-run the store's restore (mandatory for App Review) and return what turned up. */
export async function restore(): Promise<PendingPurchase[]> {
  await plugin().store.restorePurchases()
  return drainPending()
}

/** Purchases that were charged but never finished, e.g. the app was killed mid-verify. */
export function drainPending(): PendingPurchase[] {
  const all = [...approved.values()]
  approved.clear()
  return all
}
