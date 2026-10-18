import type { Nip98Signer } from '@/lib/nip98'
import { verifyPurchase, type VerifyBody, type VerifyResult } from './api'
import { forgetIntent, recallIntent, rememberIntent, type PurchaseIntent } from './intents'
import { buy, drainPending, restore, type PendingPurchase } from './iap'

/** The outcome the sheet shows. */
export type PurchaseOutcome =
  | { status: 'cancelled' }
  | { status: 'paid' }
  | { status: 'needs_attention'; reason?: string }

function bodyFor(purchase: PendingPurchase, intent: PurchaseIntent | undefined): VerifyBody {
  return {
    platform: purchase.platform,
    productId: purchase.productId,
    receipt: purchase.receipt,
    ...intent,
  }
}

/**
 * Hand a charged purchase to the backend and, only once it has been recorded,
 * tell the store we're done. A consumable that is never finished is re-sent on
 * the next start, which is safe: the backend answers `already_provisioned`.
 * A purchase the backend could not provision is NOT finished, so the store can
 * refund it instead of treating it as delivered.
 */
export async function completePurchase(
  signer: Nip98Signer,
  purchase: PendingPurchase,
  intent: PurchaseIntent | undefined = recallIntent(purchase.productId),
): Promise<PurchaseOutcome> {
  const result: VerifyResult = await verifyPurchase(signer, bodyFor(purchase, intent))
  if (result.status === 'needs_attention') {
    return { status: 'needs_attention', reason: result.reason }
  }
  await purchase.finish()
  forgetIntent(purchase.productId)
  return { status: 'paid' }
}

/** Buy a SKU through the store's sheet and confirm it with the backend. */
export async function purchase(
  signer: Nip98Signer,
  productId: string,
  intent: PurchaseIntent,
): Promise<PurchaseOutcome> {
  rememberIntent(productId, intent)
  const bought = await buy(productId)
  if (!bought) {
    forgetIntent(productId)
    return { status: 'cancelled' }
  }
  return completePurchase(signer, bought, intent)
}

/** Verify every purchase that was charged but never confirmed (run at app start). */
export async function sweepPending(signer: Nip98Signer): Promise<PurchaseOutcome[]> {
  const outcomes: PurchaseOutcome[] = []
  for (const pending of drainPending()) {
    try {
      outcomes.push(await completePurchase(signer, pending))
    } catch (err) {
      console.warn('pending purchase could not be verified yet:', err)
    }
  }
  return outcomes
}

/** "Restore purchases": re-verify past transactions. Returns whether any granted access. */
export async function restorePurchases(signer: Nip98Signer, intent: PurchaseIntent): Promise<boolean> {
  const restored = await restore()
  let any = false
  for (const item of restored) {
    const outcome = await completePurchase(signer, item, recallIntent(item.productId) ?? intent)
    if (outcome.status === 'paid') any = true
  }
  return any
}
