import { useRef } from 'react'
import type { MethodDefinition } from '@/lib/payments/types'

/**
 * Segmented control for choosing a payment method. A radiogroup with arrow-key
 * navigation, matching the tier cards' `role="radio"` pattern.
 */
export function MethodPicker({
  methods,
  selected,
  onSelect,
}: {
  methods: readonly MethodDefinition[]
  selected: string
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
              'flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
              active ? 'bg-white text-ink shadow-sm' : 'text-gray-500 hover:text-ink',
            ].join(' ')}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}
