import { useEffect, useState } from 'react'
import { fetchCurrencies, type CurrencyInfo } from './api'
import { SATS_CURRENCY, resolveDisplayCurrency } from './money'
import { useCurrencyPreference } from './preferences'

/**
 * The currency prices are shown in. `list` is undefined while loading and null
 * when card pricing is unavailable, in which case prices fall back to sats.
 */
export function useDisplayCurrency(): {
  list: CurrencyInfo[] | null | undefined
  display: string
  choose: (code: string) => void
} {
  const [list, setList] = useState<CurrencyInfo[] | null | undefined>(undefined)
  const stored = useCurrencyPreference((s) => s.currency)
  const choose = useCurrencyPreference((s) => s.setCurrency)

  useEffect(() => {
    let cancelled = false
    void fetchCurrencies().then((l) => {
      if (!cancelled) setList(l?.currencies ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const display = list ? resolveDisplayCurrency(stored, list, navigator.language) : SATS_CURRENCY
  return { list, display, choose }
}
