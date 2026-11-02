import { useEffect, useMemo, useRef, useState } from 'react'
import { Bitcoin, Check, ChevronDown, Search } from 'lucide-react'
import type { PaymentChoice } from '@/lib/payments/types'
import { fetchPaymentCurrencies, fetchPaymentsConfig } from '@/lib/payments/stripe/api'

const SATS = 'sats'
const USD = 'usd'

interface PayInPickerProps {
  /** `sats` or a lowercase fiat code. */
  value: string
  onChange: (value: string) => void
  /** Tells the pay step which rail/currency to open on. */
  onChoiceChange: (choice: PaymentChoice) => void
}

interface Option {
  value: string
  kind: 'sats' | 'fiat'
}

function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'currency' }).of(code.toUpperCase()) ?? code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

function labelFor(option: Option): string {
  return option.kind === 'sats'
    ? 'Bitcoin (Sats)'
    : `${option.value.toUpperCase()} - ${currencyName(option.value)}`
}

/**
 * What the buyer will pay in, chosen before the pay step. Bitcoin is always
 * first; card currencies come from the backend. The choice is owned by the
 * caller so it can be persisted and handed to the pay step.
 */
export default function PayInPicker({ value, onChange, onChoiceChange }: PayInPickerProps) {
  const [codes, setCodes] = useState<string[]>([])
  const [cardEnabled, setCardEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      fetchPaymentCurrencies().catch(() => [] as string[]),
      fetchPaymentsConfig().catch(() => null),
    ]).then(([list, config]) => {
      if (cancelled) return
      const enabled = Boolean(config?.stripe.enabled && config.stripe.publishableKey)
      setCardEnabled(enabled)
      setCodes(enabled ? list.filter((code) => code !== SATS) : [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // A saved currency the deployment no longer offers falls back to USD, or to
  // sats when card payments are off.
  useEffect(() => {
    if (loading) return
    const allowed = new Set([SATS, ...codes])
    if (allowed.has(value)) return
    const fallback = codes.includes(USD) ? USD : (codes[0] ?? SATS)
    onChange(fallback)
  }, [loading, codes, value, onChange])

  // Keep the pay step's choice in step with the visible value, including the
  // fallback above before the parent has re-rendered with it.
  useEffect(() => {
    if (loading) return
    const allowed = new Set([SATS, ...codes])
    const effective = allowed.has(value) ? value : (codes.includes(USD) ? USD : (codes[0] ?? SATS))
    onChoiceChange(
      effective === SATS
        ? { methodId: 'lightning' }
        : { methodId: 'stripe', currency: effective, autoStart: true },
    )
  }, [loading, codes, value, onChoiceChange])

  const options = useMemo<Option[]>(
    () => [{ value: SATS, kind: 'sats' }, ...codes.map((code) => ({ value: code, kind: 'fiat' as const }))],
    [codes],
  )
  const selected = options.find((option) => option.value === value) ?? options[0]

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((option) => {
      if (option.kind === 'sats') return ['bitcoin', 'sats', 'btc'].some((word) => word.includes(q))
      return option.value.includes(q) || labelFor(option).toLowerCase().includes(q)
    })
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const choose = (option: Option) => {
    onChange(option.value)
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => Math.min(index + 1, filtered.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = filtered[active]
      if (option) choose(option)
    }
  }

  const note =
    value !== SATS && value !== USD
      ? 'Final price may change with the exchange rate.'
      : !loading && !cardEnabled
        ? 'Card payments are unavailable right now.'
        : null

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Pay in"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="pay-in-options"
        disabled={loading}
        onClick={() => {
          setActive(0)
          setOpen((isOpen) => !isOpen)
        }}
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-black/15 bg-white px-3 py-2.5 text-left text-sm text-ink transition-colors hover:border-black/25 focus:border-primary focus:outline-none disabled:cursor-wait disabled:opacity-60"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected?.kind === 'sats' ? (
            <Bitcoin size={16} className="shrink-0 text-ink" />
          ) : (
            <span className="shrink-0 rounded-md bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-gray-500">
              {(selected?.value ?? USD).toUpperCase()}
            </span>
          )}
          <span className="truncate">
            {loading ? 'Loading payment options…' : selected ? labelFor(selected) : 'Choose currency'}
          </span>
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute top-full z-20 mt-2 w-full overflow-hidden rounded-xl border border-black/10 bg-white shadow-2xl">
          <div className="border-b border-black/5 p-2">
            <div className="flex items-center gap-2 rounded-lg border border-black/10 bg-black/[0.03] px-2.5 py-2">
              <Search size={14} className="shrink-0 text-gray-400" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setActive(0)
                  setQuery(event.target.value)
                }}
                onKeyDown={onKeyDown}
                aria-label="Search currency"
                placeholder="Search currency"
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-gray-400"
              />
            </div>
          </div>
          <ul
            id="pay-in-options"
            role="listbox"
            aria-label="Pay in currency"
            className="max-h-60 overflow-y-auto p-1.5"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-sm text-gray-500">No currencies found</li>
            ) : (
              filtered.map((option, index) => {
                const isSelected = option.value === selected?.value
                return (
                  <li key={option.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(option)}
                      className={[
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                        index === active ? 'bg-black/[0.04]' : 'bg-transparent',
                        isSelected ? 'font-semibold text-ink' : 'text-gray-600',
                      ].join(' ')}
                    >
                      {option.kind === 'sats' ? (
                        <Bitcoin size={15} className="shrink-0" />
                      ) : (
                        <span className="w-10 shrink-0 rounded-md bg-black/[0.06] px-1.5 py-0.5 text-center text-[10px] font-bold tracking-wide text-gray-500">
                          {option.value.toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{labelFor(option)}</span>
                      {isSelected && <Check size={15} className="shrink-0 text-ink" />}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      )}

      {note && <p className="mt-1.5 text-[11px] text-subtle">{note}</p>}
    </div>
  )
}
