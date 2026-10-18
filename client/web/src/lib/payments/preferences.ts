import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** The payment method the buyer used last; overrides the build's default order. */
interface MethodPreference {
  method: string | null
  setMethod: (method: string) => void
}

export const useMethodPreference = create<MethodPreference>()(
  persist(
    (set) => ({
      method: null,
      setMethod: (method) => set({ method }),
    }),
    { name: 'mailstr.pay.method' },
  ),
)
