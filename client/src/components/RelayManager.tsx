import { useState } from 'react'
import { Button, IconButton } from '@/components/ui/Button'
import { XIcon, PlusIcon } from '@/components/ui/icons'

const inputClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-[12px] text-foreground placeholder:text-subtle focus:outline-none'

/** A relay is a websocket URL — wss:// in production, ws:// tolerated for local. */
function normalizeRelay(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null
    return trimmed
  } catch {
    return null
  }
}

/**
 * Edit a list of relay URLs — add, remove, validate. Fully controlled: the
 * parent owns the array and decides when to persist it. Shared by the one-time
 * onboarding screen and the Settings "Relays" section so both read and write
 * the list the same way.
 */
export function RelayManager({
  relays,
  onChange,
}: {
  relays: string[]
  onChange: (relays: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  function addRelay() {
    const url = normalizeRelay(draft)
    if (!url) {
      setError('Enter a relay URL starting with wss://')
      return
    }
    if (relays.some((r) => r.toLowerCase() === url.toLowerCase())) {
      setError('That relay is already in the list')
      return
    }
    onChange([...relays, url])
    setDraft('')
    setError('')
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {relays.length === 0 && (
          <li className="text-[11.5px] text-subtle">No relays yet — add at least one below.</li>
        )}
        {relays.map((r) => (
          <li
            key={r}
            className="flex items-center gap-2 rounded-md border border-input bg-muted px-3 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{r}</span>
            <IconButton
              title={`Remove ${r}`}
              onClick={() => onChange(relays.filter((x) => x !== r))}
              className="h-6 w-6"
            >
              <XIcon className="h-3.5 w-3.5" />
            </IconButton>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError('')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addRelay()
            }
          }}
          placeholder="wss://relay.example.com"
          className={inputClass}
        />
        <Button onClick={addRelay} disabled={!draft.trim()} className="flex-none">
          <PlusIcon className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {error && <p className="text-[11.5px] text-destructive">{error}</p>}
    </div>
  )
}
