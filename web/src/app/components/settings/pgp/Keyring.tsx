import { useState } from 'react'
import type { KeyringEntry } from '@/app/lib/pgp/keyring'
import { Button } from '@/app/components/ui/Button'
import { TrashIcon, PlusIcon } from '@/app/components/ui/icons'
import { inputClass, areaClass, formatFingerprint } from '@/app/components/settings/pgp/shared'

/** The correspondent keyring list + an add form. */
export function Keyring({
  entries,
  busy,
  onAdd,
  onRemove,
  setError,
}: {
  entries: KeyringEntry[]
  busy: boolean
  onAdd: (armored: string, forAddress: string) => Promise<void>
  onRemove: (address: string) => void
  setError: (m: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [armored, setArmored] = useState('')
  const [forAddress, setForAddress] = useState('')
  const [working, setWorking] = useState(false)

  return (
    <div className="flex flex-col gap-2">
      {entries.length > 0 && (
        <div className="flex flex-col gap-1">
          {entries.map((e) => (
            <div
              key={e.address}
              className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-foreground">{e.address}</div>
                <div className="truncate font-mono text-[10px] text-subtle">
                  {formatFingerprint(e.fingerprint)}
                </div>
              </div>
              <button
                type="button"
                title={`Remove ${e.address}`}
                onClick={() => onRemove(e.address)}
                disabled={busy}
                className="flex-none rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={armored}
            onChange={(e) => setArmored(e.target.value)}
            placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
            rows={4}
            className={areaClass}
          />
          <input
            value={forAddress}
            onChange={(e) => setForAddress(e.target.value)}
            placeholder="Also file under this address (optional)"
            className={inputClass}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={working || !armored.trim()}
              onClick={async () => {
                setWorking(true)
                setError('')
                try {
                  await onAdd(armored.trim(), forAddress.trim())
                  setAdding(false)
                  setArmored('')
                  setForAddress('')
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setWorking(false)
                }
              }}
            >
              {working ? 'Adding…' : 'Add key'}
            </Button>
            <Button size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" onClick={() => setAdding(true)} disabled={busy} className="self-start">
          <PlusIcon className="h-3.5 w-3.5" />
          Add a correspondent’s key
        </Button>
      )}
    </div>
  )
}