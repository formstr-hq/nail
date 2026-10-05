import { useCallback, useState } from 'react'
import { Button } from '@/app/components/ui/Button'
import { PlusIcon, TrashIcon } from '@/app/components/ui/icons'
import { Field, inputClass } from '@/app/components/settings/Field'
import type { WorkspaceDomain } from '@/app/lib/api/workspace'
import { VerifyStatus } from './presenters'

/**
 * The domain list: pick one to work on, add a new one, remove one.
 *
 * Add sits first (it is the entry point), then the list. Selecting a domain
 * switches the detail pane; the list is compact so the detail is what fills
 * the screen.
 */
export function DomainsPanel({
  domains,
  selected,
  loading,
  onSelect,
  onAdded,
  onDelete,
}: {
  domains: WorkspaceDomain[]
  selected: string | null
  loading: boolean
  onSelect: (domain: string) => void
  onAdded: (domain: string) => Promise<void>
  onDelete: (domain: WorkspaceDomain) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <AddDomainForm onAdded={onAdded} />

      {loading && domains.length === 0 && (
        <p className="text-[11.5px] text-subtle">Loading your domains…</p>
      )}

      {!loading && domains.length === 0 && (
        <p className="text-[11.5px] leading-relaxed text-subtle">
          Add a domain above and we&apos;ll show you exactly which DNS records to
          publish, then verify it for you.
        </p>
      )}

      {domains.length > 0 && (
        <Field label="Your domains">
          <div className="flex flex-col gap-1">
            {domains.map((d) => (
              <div
                key={d.domain}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 ${
                  d.domain === selected ? 'border-primary bg-muted' : 'border-input'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(d.domain)}
                  className="min-w-0 flex-1 truncate text-left font-mono text-[11px]"
                >
                  {d.domain}
                </button>
                <VerifyStatus status={d.status} />
                <button
                  type="button"
                  aria-label={`Delete ${d.domain}`}
                  title="Delete this domain"
                  onClick={() => onDelete(d)}
                  className="flex-none text-subtle hover:text-destructive"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </Field>
      )}
    </div>
  )
}

/** Add a domain — the first action in the domain list. */
function AddDomainForm({ onAdded }: { onAdded: (domain: string) => Promise<void> }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    const domain = value.trim()
    if (!domain) return
    setBusy(true)
    setError(null)
    try {
      await onAdded(domain)
      setValue('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [value, onAdded])

  return (
    <Field
      label="Add a domain"
      hint="You'll need access to its DNS settings. Nothing is routed until it is verified."
    >
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="yourdomain.com"
          aria-label="Domain name"
          className={inputClass}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
        <Button size="sm" variant="primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
          <PlusIcon className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {error && <p className="mt-1.5 text-[11.5px] text-destructive">{error}</p>}
    </Field>
  )
}
