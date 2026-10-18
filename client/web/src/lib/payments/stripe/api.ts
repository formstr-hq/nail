// Card payments: the backend's config, currency list, quotes, checkout and
// order status. Nothing outside the card method may import this (store
// bundles must not contain it); lib/payments/methods.ts loads it.
import type { Nip98Signer } from '@/lib/nip98'
import { ApiError, request } from '../http'

export interface PaymentsConfig {
  stripe: { enabled: boolean; publishableKey: string | null }
  lightning: { enabled: boolean }
}

export interface CurrencyInfo {
  code: string
  name: string
  exponent: number
}

export interface CurrencyList {
  currencies: CurrencyInfo[]
  default: string | null
}

export type QuoteRequest =
  | { product: 'mail'; currency: string; tierId: string }
  | { product: 'workspace'; currency: string; seats: number }

export interface Quote {
  currency: string
  exponent: number
  /** Minor units of `currency`, before tax. */
  amountMinor: number
  /** ISO time after which checkout refuses this quote. */
  expiresAt: string
  quoteToken: string
  minimumApplied?: boolean
}

export interface CheckoutRequest {
  product: 'mail' | 'workspace'
  quoteToken: string
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

/** Why checkout refused a quote; the sheet fetches a fresh one and asks again. */
export type QuoteConflictReason = 'quote_expired' | 'quote_invalid' | 'quote_mismatch' | 'price_changed'

export class QuoteConflict extends Error {
  reason: QuoteConflictReason
  constructor(reason: QuoteConflictReason) {
    super(`The price changed (${reason})`)
    this.name = 'QuoteConflict'
    this.reason = reason
  }
}

/** Card is offered only when the deployment has it and the rates are fresh. */
export class CardUnavailable extends Error {}

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
  currenciesPromise = null
}

let currenciesPromise: Promise<CurrencyList | null> | null = null

/** The currencies a card can be priced in; null when card is off or the call fails (cached once). */
export function fetchCurrencies(): Promise<CurrencyList | null> {
  currenciesPromise ??= request<CurrencyList>('/api/payments/currencies')
    .then((list) => (list.currencies?.length ? list : null))
    .catch(() => {
      currenciesPromise = null
      return null
    })
  return currenciesPromise
}

/** Unauthenticated. A 503 means the exchange rates are stale: card is unavailable. */
export async function requestQuote(body: QuoteRequest): Promise<Quote> {
  try {
    return await request<Quote>('/api/quotes', { body })
  } catch (err) {
    if (err instanceof ApiError && (err.status === 503 || err.status === 404)) {
      throw new CardUnavailable(err.message)
    }
    throw err
  }
}

/** Create the order and the Checkout Session for an accepted quote. */
export async function createCheckout(
  signer: Nip98Signer,
  body: CheckoutRequest,
): Promise<CheckoutSession> {
  try {
    return await request<CheckoutSession>('/api/stripe/checkout', { body, signer })
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.reason) {
      throw new QuoteConflict(err.reason as QuoteConflictReason)
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
