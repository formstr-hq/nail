// Lightning payments: invoice requests, the settlement socket and everything
// that reads a price in sats. Nothing outside the Lightning method may import
// this (store bundles must not contain it); lib/payments/methods.ts loads it.
import { config } from '@/lib/config'
import type { MailTier } from '@/lib/api'
import type { Nip98Signer } from '@/lib/nip98'
import { apiUrl } from '@/app/lib/api/config'
import { request } from '../http'

export interface LightningInvoice {
  invoice: string
  paymentHash: string
  amount: number
}

export interface SeatInvoice extends LightningInvoice {
  seats: number
  pricePerSeatSats: number
}

/** Ask the backend for a Lightning invoice that, once paid, provisions the mailbox. */
export function generateMailInvoice(
  signer: Nip98Signer,
  body: { pubkey: string; nip05: string; tierId: string },
): Promise<LightningInvoice> {
  return request<LightningInvoice>('/api/generate-invoice/mail', { body, signer })
}

/** Start a seat purchase; the caller watches the payment socket on `paymentHash`. */
export function createSeatInvoice(
  signer: Nip98Signer,
  domain: string,
  seats: number,
): Promise<SeatInvoice> {
  return request<SeatInvoice>('/api/workspace/generate-invoice', { body: { domain, seats }, signer })
}

/** WebSocket that fires { status: "paid" } once the invoice settles. */
export function paymentSocket(paymentHash: string): WebSocket {
  return new WebSocket(`${config.wsBaseUrl}/ws?hash=${paymentHash}`)
}

/** The tier's price in sats, or null when the backend sent none. */
export function tierSats(tier: MailTier): { amount: number; unit: string } | null {
  const amount = tier.pricing.priceSats
  if (typeof amount !== 'number') return null
  return { amount, unit: typeof tier.pricing.unit === 'string' ? tier.pricing.unit : 'sats' }
}

/** The flat per-seat price and the allowed purchase range (public). */
export interface SeatPricing {
  pricePerSeatSats: number
  minSeats: number
  maxSeats: number
}

export async function fetchSeatPricing(): Promise<SeatPricing> {
  const res = await fetch(apiUrl('/api/workspace/seat-price'))
  if (!res.ok) throw new Error(`Could not load the seat price (${res.status})`)
  return (await res.json()) as SeatPricing
}
