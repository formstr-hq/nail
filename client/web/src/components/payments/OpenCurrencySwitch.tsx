import { SATS_CURRENCY } from '@/lib/payments/stripe/money'
import { useDisplayCurrency } from '@/lib/payments/stripe/useDisplayCurrency'
import { CurrencySelect } from './CurrencySelect'

/** "Show prices in [USD ▾]": display only; the binding price is the quote accepted at payment. */
export default function OpenCurrencySwitch() {
  const { list, display, choose } = useDisplayCurrency()
  // Without card pricing there is nothing to switch between.
  if (!list) return null
  return (
    <label className="mt-3 flex items-center justify-end gap-2 text-xs text-gray-500">
      Show prices in
      <CurrencySelect
        currencies={list}
        value={display}
        onChange={choose}
        extra={[{ code: SATS_CURRENCY, name: 'sats' }]}
        label="Show prices in"
      />
    </label>
  )
}
