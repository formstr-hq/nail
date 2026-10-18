// In-app purchases: the backend side. Nothing outside the store method may
// import this; lib/payments/methods.ts loads it in store builds only.
import type { Nip98Signer } from '@/lib/nip98'
import { request } from '../http'

export type StorePlatform = 'apple' | 'google'

export interface StoreReceiptBody {
  transactionId?: string
  purchaseToken?: string
  orderId?: string
}

export interface VerifyBody {
  platform: StorePlatform
  productId: string
  receipt: StoreReceiptBody
  /** Mailbox purchases. */
  nip05?: string
  tierId?: string
  pubkey?: string
  /** Seat packs. The seat count is never sent: the store catalog decides it. */
  domain?: string
}

export type VerifyResult =
  | { status: 'provisioned' | 'already_provisioned'; address?: string; seats?: number }
  | { status: 'needs_attention'; reason?: string }

export function verifyPurchase(signer: Nip98Signer, body: VerifyBody): Promise<VerifyResult> {
  return request<VerifyResult>('/api/store/verify', { body, signer })
}

export interface SeatPack {
  seats: number
  apple: string | null
  google: string | null
}

/** The fixed seat packs the stores sell, with their SKU ids. */
export async function fetchSeatPacks(): Promise<SeatPack[]> {
  const tiers = await request<Array<{ storePacks?: SeatPack[] }>>('/api/tiers/workspace')
  return tiers.flatMap((t) => t.storePacks ?? [])
}
