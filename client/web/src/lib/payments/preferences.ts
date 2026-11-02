import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'

// Keep the remembered method usable where the browser storage API is absent
// (SSR and some test runtimes); it simply does not persist across reloads.
const memory = new Map<string, string>()
const memoryStorage: StateStorage = {
  getItem: (name) => memory.get(name) ?? null,
  setItem: (name, value) => {
    memory.set(name, value)
  },
  removeItem: (name) => {
    memory.delete(name)
  },
}

/** The payment method the buyer used last; overrides the build's default order. */
interface MethodPreference {
  method: string | null
  setMethod: (method: string) => void
}

// Read the browser's storage explicitly: in some test/SSR runtimes a
// bare `localStorage` resolves to a non-browser global instead.
const storage = () =>
  createJSONStorage(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
    } catch {
      // Storage can be disabled by policy; fall through to memory.
    }
    return memoryStorage
  })

export const useMethodPreference = create<MethodPreference>()(
  persist(
    (set) => ({
      method: null,
      setMethod: (method) => set({ method }),
    }),
    { name: 'mailstr.pay.method', storage: storage() },
  ),
)

/** The card currency the buyer chose last; usd until they pick another. */
interface CurrencyPreference {
  currency: string
  setCurrency: (currency: string) => void
}

export const useCurrencyPreference = create<CurrencyPreference>()(
  persist(
    (set) => ({
      currency: 'usd',
      setCurrency: (currency) => set({ currency }),
    }),
    { name: 'mailstr.pay.currency', storage: storage() },
  ),
)
