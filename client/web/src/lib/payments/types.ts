import type { Nip98Signer } from '@/lib/nip98'

/** What a payment sheet is asked to sell. */
export type PayOrder =
  | { product: 'mail'; pubkey: string; nip05: string; tierId: string }
  /** Open builds: any seat quantity. */
  | { product: 'workspace'; domain: string; seats: number }
  /** Store builds: a fixed pack, identified by its seat count. */
  | { product: 'workspace'; domain: string; packSeats: number }

/** Neutral method id; the concrete ids live with the method modules. */
export type MethodId = string

/** A rail/currency choice made before the pay step. The concrete ids live with the method modules. */
export interface PaymentChoice {
  methodId: MethodId
  /** Card presentment currency, when the chosen method takes one. */
  currency?: string
}

/** How a method finished. `confirmed` means the backend said paid, never the client's own belief. */
export type PayResult =
  | { status: 'paid' }
  /** Paid, but the purchase could not be created. A terminal error with a reason. */
  | { status: 'needs_attention'; reason?: string }

/** Props every payment method component receives. */
export interface MethodProps {
  order: PayOrder
  signer: Nip98Signer
  /** The mail tier being bought (mail orders only). */
  tier?: import('@/lib/api').MailTier | null
  /** Fixed USD cents for this order, shown before and at payment. */
  priceUsd?: number | null
  /** Presentment currency chosen before the pay step (card methods only). */
  currency?: string
  /** Lets a method report a refreshed config price after a 409 price_changed. */
  onPriceUsdChange?: (priceUsd: number) => void
  onResult: (result: PayResult) => void
  /** Show or clear a banner above the method. */
  onError: (message: string | null) => void
}

/** What a method needs to state the amount it will charge. */
export interface MethodPriceContext {
  order: PayOrder
  tier?: import('@/lib/api').MailTier | null
  priceUsd?: number | null
}

/** A payment method the sheet can offer. */
export interface MethodDefinition {
  id: MethodId
  label: string
  /** The amount this method charges, shown under its label in the picker. */
  price?: (context: MethodPriceContext) => string | null | Promise<string | null>
  /** Resolves false when this deployment can't take the method right now (card off, rates stale). */
  available?: () => Promise<boolean>
  Component: React.ComponentType<MethodProps>
}
