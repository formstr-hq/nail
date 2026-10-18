import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** The buyer's remembered display currency (a code, or "sats"). */
interface CurrencyPreference {
  currency: string | null
  setCurrency: (currency: string) => void
}

export const useCurrencyPreference = create<CurrencyPreference>()(
  persist(
    (set) => ({
      currency: null,
      setCurrency: (currency) => set({ currency }),
    }),
    { name: 'mailstr.pay.currency' },
  ),
)
