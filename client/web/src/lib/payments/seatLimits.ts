import { apiUrl } from '@/app/lib/api/config'

/** How many seats one purchase may cover, and the fixed per-seat card price. */
export interface SeatLimits {
  minSeats: number
  maxSeats: number
  /** Fixed USD cents per seat, or null when card pricing is not configured. */
  seatPriceUsd: number | null
}

const FALLBACK: SeatLimits = { minSeats: 1, maxSeats: 1000, seatPriceUsd: null }

/** The allowed seat range and USD price, or the documented defaults when unreadable. */
export async function fetchSeatLimits(): Promise<SeatLimits> {
  try {
    const res = await fetch(apiUrl('/api/workspace/seat-price'))
    if (!res.ok) return FALLBACK
    const body = (await res.json()) as Partial<SeatLimits>
    return {
      minSeats: typeof body.minSeats === 'number' ? body.minSeats : FALLBACK.minSeats,
      maxSeats: typeof body.maxSeats === 'number' ? body.maxSeats : FALLBACK.maxSeats,
      seatPriceUsd:
        typeof body.seatPriceUsd === 'number' && body.seatPriceUsd > 0 ? body.seatPriceUsd : null,
    }
  } catch {
    return FALLBACK
  }
}
