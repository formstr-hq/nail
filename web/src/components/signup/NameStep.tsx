import { AtSign, Check, Loader2, X } from 'lucide-react'
import { config } from '@/lib/config'
import type { MailTier } from '@/lib/api'

export type Availability = 'idle' | 'checking' | 'free' | 'taken' | 'invalid' | 'error'

interface NameStepProps {
  name: string
  onNameChange: (value: string) => void
  availability: Availability
  address: string
  tiers: MailTier[] | null
  selectedTierId: string | null
  onSelectTier: (id: string) => void
  busy: boolean
  onRequestInvoice: () => void
  onRetryCheck: () => void
}

/** Step 2 — pick the address and plan, then request the invoice. */
export function NameStep({
  name,
  onNameChange,
  availability,
  address,
  tiers,
  selectedTierId,
  onSelectTier,
  busy,
  onRequestInvoice,
  onRetryCheck,
}: NameStepProps) {
  const selectedTier = tiers?.find((t) => t.id === selectedTierId) ?? null

  return (
    <div>
      <label className="mb-1.5 block text-sm font-semibold text-ink">Your address</label>
      <div className="flex items-stretch overflow-hidden rounded-xl border border-black/15 bg-white focus-within:border-primary">
        <span className="flex items-center pl-3 text-gray-400">
          <AtSign size={15} />
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value.toLowerCase().trim())}
          placeholder="you"
          className="min-w-0 flex-1 bg-transparent px-2 py-3 text-sm text-ink outline-none"
        />
        <span className="flex items-center border-l border-black/5 bg-black/[0.03] px-3 font-mono text-sm text-gray-500">
          @{config.mailDomain}
        </span>
      </div>

      <p className="mt-2 min-h-5 text-sm">
        {availability === 'checking' && (
          <span className="inline-flex items-center gap-1.5 text-gray-400">
            <Loader2 size={13} className="animate-spin" /> Checking…
          </span>
        )}
        {availability === 'free' && (
          <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-600">
            <Check size={14} /> {address} is available
          </span>
        )}
        {availability === 'taken' && (
          <span className="font-semibold text-red-600">{address} is taken — try another</span>
        )}
        {availability === 'invalid' && (
          <span className="text-gray-500">
            Lowercase letters, digits, dots, underscores and hyphens only.
          </span>
        )}
        {availability === 'error' && (
          <span className="inline-flex items-center gap-2 text-gray-500">
            Couldn't check availability.
            <button
              type="button"
              onClick={onRetryCheck}
              className="font-semibold text-primary underline"
            >
              Retry
            </button>
          </span>
        )}
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {tiers === null ? (
          <div className="flex items-center justify-center rounded-xl border border-black/10 bg-white p-6">
            <Loader2 size={18} className="animate-spin text-gray-300" />
          </div>
        ) : (
          tiers.map((t) => {
            const selected = t.id === selectedTierId
            return (
              <div
                key={t.id}
                role="radio"
                aria-checked={selected}
                aria-disabled={!t.available}
                tabIndex={t.available ? 0 : -1}
                onClick={() => t.available && onSelectTier(t.id)}
                onKeyDown={(e) => {
                  if (t.available && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    onSelectTier(t.id)
                  }
                }}
                className={[
                  'rounded-xl border p-4 text-left transition-colors',
                  t.available ? 'cursor-pointer' : 'cursor-default opacity-60',
                  selected
                    ? 'border-primary bg-white ring-1 ring-primary'
                    : 'border-black/10 bg-white hover:border-black/20',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-base font-bold text-ink">{t.name}</h4>
                      {!t.available && (
                        <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                          Coming soon
                        </span>
                      )}
                    </div>
                    {t.description && (
                      <p className="mt-0.5 text-xs text-gray-500">{t.description}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="text-lg font-bold leading-none text-ink">
                      {t.priceSats.toLocaleString()}
                    </span>
                    <span className="ml-1 text-sm text-gray-500">{t.unit}</span>
                    <span className="block text-[11px] text-gray-400">{t.billing}</span>
                  </div>
                </div>
                {(t.features.length > 0 || t.notIncluded.length > 0) && (
                  <ul className="mt-3 flex flex-col gap-1.5 text-sm">
                    {t.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-gray-600">
                        <Check size={15} className="shrink-0 text-emerald-600" />
                        <span>{f}</span>
                      </li>
                    ))}
                    {t.notIncluded.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-gray-400">
                        <X size={15} className="shrink-0" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })
        )}
      </div>

      <button
        disabled={availability !== 'free' || busy || !selectedTier}
        onClick={onRequestInvoice}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white transition-all enabled:hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <>
            <Loader2 size={15} className="animate-spin" /> Preparing invoice…
          </>
        ) : (
          <>
            Get {selectedTier?.name ?? 'Mail'}
            {selectedTier ? ` — ${selectedTier.priceSats.toLocaleString()} ${selectedTier.unit}` : ''}
          </>
        )}
      </button>
      {selectedTier && (
        <p className="mt-2 text-center text-xs text-gray-400">
          {selectedTier.billing === 'one-time'
            ? 'Paid once. No recurring charge.'
            : `Billed ${selectedTier.billing}.`}
        </p>
      )}
    </div>
  )
}
