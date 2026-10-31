import { useRef } from 'react'
import type { MethodDefinition } from '@/lib/payments/types'

/**
 * Segmented control for choosing a payment method. A radiogroup with arrow-key
 * navigation, matching the tier cards' `role="radio"` pattern.
 */
export function MethodPicker({
  methods,
  selected,
  prices,
  onSelect,
}: {
  methods: readonly MethodDefinition[]
  selected: string
  /** The amount each method charges, shown under its label. */
  prices?: Readonly<Record<string, string | null>>
  onSelect: (id: string) => void
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  const move = (from: number, delta: number) => {
    const next = methods[(from + delta + methods.length) % methods.length]
    onSelect(next.id)
    refs.current[next.id]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Payment method"
      className="mb-4 flex rounded-xl border border-black/10 bg-black/[0.03] p-1"
    >
      {methods.map((m, i) => {
        const active = m.id === selected
        return (
          <button
            key={m.id}
            ref={(el) => {
              refs.current[m.id] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(m.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                move(i, 1)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(i, -1)
              }
            }}
            className={[
              'flex flex-1 flex-col items-center justify-center rounded-lg px-3 py-2 transition-colors',
              active ? 'bg-white text-ink shadow-sm' : 'text-gray-500 hover:text-ink',
            ].join(' ')}
          >
            <span className="text-sm font-semibold">{m.label}</span>
            {prices?.[m.id] && (
              <span className="text-xs font-normal text-gray-500">{prices[m.id]}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
