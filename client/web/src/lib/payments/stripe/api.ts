// Card payments: the backend's config, fixed-price checkout and order status.
// Nothing outside the card method may import this (store bundles must not
// contain it); lib/payments/methods.ts loads it.
import type { Nip98Signer } from '@/lib/nip98'
import { ApiError, request } from '../http'

export interface PaymentsConfig {
  stripe: { enabled: boolean; publishableKey: string | null }
  lightning: { enabled: boolean }
}

export interface CheckoutRequest {
  product: 'mail' | 'workspace'
  /** The price the client displayed, so the backend can detect a config change. */
  expectedPriceUsd?: number
  uiMode: 'embedded' | 'hosted'
  returnUrl?: string
  tierId?: string
  nip05?: string
  domain?: string
  seats?: number
}

export interface CheckoutSession {
  sessionId: string
  clientSecret?: string
  url?: string
  amount: number
  currency: string
}

/** Checkout refused because the configured USD price moved since page load. */
export class PriceChanged extends Error {
  constructor() {
    super('The price changed')
    this.name = 'PriceChanged'
  }
}

let configPromise: Promise<PaymentsConfig | null> | null = null

/** The deployment's payment config, or null when it can't be read (cached once). */
export function fetchPaymentsConfig(): Promise<PaymentsConfig | null> {
  configPromise ??= request<PaymentsConfig>('/api/payments/config').catch(() => {
    configPromise = null
    return null
  })
  return configPromise
}

/** For tests. */
export function resetPaymentsConfigCache(): void {
  configPromise = null
}

/** Create the order and the Checkout Session for the fixed USD price. */
export async function createCheckout(
  signer: Nip98Signer,
  body: CheckoutRequest,
): Promise<CheckoutSession> {
  try {
    return await request<CheckoutSession>('/api/stripe/checkout', { body, signer })
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.reason === 'price_changed') {
      throw new PriceChanged()
    }
    throw err
  }
}

export type OrderStatus =
  | { status: 'pending' | 'expired' | 'needs_attention' }
  | { status: 'paid'; data?: string }

export function fetchOrderStatus(sessionId: string): Promise<OrderStatus> {
  return request<OrderStatus>(`/api/orders/${encodeURIComponent(sessionId)}/status`)
}
