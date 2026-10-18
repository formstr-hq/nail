import { apiUrl } from '@/app/lib/api/config'

/** How many seats one purchase may cover (public). */
export interface SeatLimits {
  minSeats: number
  maxSeats: number
}

const FALLBACK: SeatLimits = { minSeats: 1, maxSeats: 1000 }

/** The allowed seat range, or the documented default when it can't be read. */
export async function fetchSeatLimits(): Promise<SeatLimits> {
  try {
    const res = await fetch(apiUrl('/api/workspace/seat-price'))
    if (!res.ok) return FALLBACK
    const body = (await res.json()) as Partial<SeatLimits>
    return {
      minSeats: typeof body.minSeats === 'number' ? body.minSeats : FALLBACK.minSeats,
      maxSeats: typeof body.maxSeats === 'number' ? body.maxSeats : FALLBACK.maxSeats,
    }
  } catch {
    return FALLBACK
  }
}
