import { getMailTiers } from '@/lib/api'
import { fetchSeatLimits } from './seatLimits'

/** Re-read a mail tier's fixed USD price from the tiers endpoint. */
export async function currentMailPriceUsd(tierId: string): Promise<number | null> {
  const tiers = await getMailTiers()
  return tiers.find((tier) => tier.id === tierId)?.priceUsd ?? null
}

/** Re-read the fixed per-seat USD price and turn it into an order total. */
export async function currentSeatTotalUsd(seats: number): Promise<number | null> {
  const limits = await fetchSeatLimits()
  return limits.seatPriceUsd === null ? null : limits.seatPriceUsd * seats
}
