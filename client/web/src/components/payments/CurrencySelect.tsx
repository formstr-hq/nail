import type { CurrencyInfo } from '@/lib/payments/stripe/api'

/** A currency dropdown. `extra` adds non-currency choices such as "sats" on the price switcher. */
export function CurrencySelect({
  id,
  currencies,
  value,
  onChange,
  extra = [],
  label,
}: {
  id?: string
  currencies: readonly CurrencyInfo[]
  value: string
  onChange: (code: string) => void
  extra?: ReadonlyArray<{ code: string; name: string }>
  label?: string
}) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-black/15 bg-white px-2.5 py-1.5 text-sm text-ink outline-none focus:border-primary"
    >
      {currencies.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code.toUpperCase()} — {c.name}
        </option>
      ))}
      {extra.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
  )
}
