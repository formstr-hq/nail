import { useState } from 'react'
import type { PgpKeypair } from '@/app/lib/nostr/settings'
import { generateKeySet } from '@/app/lib/pgp/openpgp'
import { keypairFromSet } from '@/app/lib/pgp/install'
import { ownPublicKeysFor } from '@/app/lib/pgp/keyring'
import { Button } from '@/app/components/ui/Button'
import { KeyIcon } from '@/app/components/ui/icons'
import { formatFingerprint } from '@/app/components/settings/pgp/shared'
import { republishOwnKey } from '@/app/components/settings/pgp/wkdPublish'
import { KeyExportDialog } from '@/app/components/settings/pgp/KeyExportDialog'
import { RotateKeyDialog } from '@/app/components/settings/pgp/RotateKeyDialog'
import { ImportKeyForm } from '@/app/components/settings/pgp/ImportKeyForm'

/**
 * One alias row: shows its key if it has one, else offers generate/import.
 *
 * `disabledReason` marks an alias that cannot hold a key at all (see
 * PgpSettings: the npub bridge address has no nip05 row, so WKD publish can
 * never succeed for it). The whole row is inert in that case.
 */
export function AliasKeyRow({
  address,
  keypair,
  busy,
  onInstall,
  onRotate,
  setError,
  disabledReason,
}: {
  address: string
  keypair: PgpKeypair | undefined
  busy: boolean
  /** Store a fresh keypair for this alias (WKD publish included, or nothing is kept). */
  onInstall: (keypair: PgpKeypair) => Promise<boolean>
  /** Replace this alias's keypair (confirmation dialog owns the warning). */
  onRotate: (keypair: PgpKeypair) => Promise<boolean>
  setError: (m: string) => void
  disabledReason?: string
}) {
  const [mode, setMode] = useState<'idle' | 'import'>('idle')
  const [working, setWorking] = useState(false)
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [republishing, setRepublishing] = useState(false)
  const [republished, setRepublished] = useState(false)
  const [confirmingRotate, setConfirmingRotate] = useState(false)

  if (disabledReason && !keypair) {
    return (
      <div className="rounded-md border border-dashed border-input p-3 opacity-60">
        <div className="flex items-center gap-2">
          <KeyIcon className="h-4 w-4 flex-none text-subtle" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{address}</span>
        </div>
        <p className="mt-1 pl-6 text-[10.5px] leading-relaxed text-subtle">{disabledReason}</p>
      </div>
    )
  }

  // Generate runs immediately — no confirm panel. The key is installed
  // (stored + published) or nothing of it is kept (lib/pgp/install.ts).
  async function generateNow() {
    setWorking(true)
    setError('')
    try {
      const gen = await generateKeySet({ email: address })
      await onInstall(keypairFromSet(gen))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
    }
  }

  // Has a key — show fingerprint, copy, export, republish, rotate.
  if (keypair) {
    return (
      <div className="rounded-md border border-input bg-muted/40 p-3">
        <div className="flex items-center gap-2">
          <KeyIcon className="h-4 w-4 flex-none text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">{address}</span>
          {keypair.passphraseProtected && (
            <span className="flex-none text-[10px] text-subtle">passphrase-protected</span>
          )}
        </div>
        <div className="mt-1 break-all pl-6 font-mono text-[10px] text-subtle">
          {formatFingerprint(keypair.fingerprint)}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 pl-6">
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(keypair.publicKey).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy public key'}
          </Button>
          <Button size="sm" onClick={() => setExporting(true)}>
            Export
          </Button>
          {/* A disabled alias (the npub bridge address) can hold a legacy key,
              but it cannot publish — Republish and Rotate would 403 forever,
              so they are hidden and only the key-material actions remain. */}
          {!disabledReason && (
            <>
              <Button
                size="sm"
                disabled={republishing}
                onClick={() => {
                  setRepublishing(true)
                  setRepublished(false)
                  setError('')
                  republishOwnKey(address, ownPublicKeysFor(keypair))
                    .then(() => {
                      setRepublished(true)
                      setTimeout(() => setRepublished(false), 2500)
                    })
                    .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setRepublishing(false))
                }}
              >
                {republishing ? 'Publishing…' : republished ? 'Published' : 'Republish to WKD'}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy || confirmingRotate}
                onClick={() => setConfirmingRotate(true)}
              >
                Rotate key
              </Button>
            </>
          )}
        </div>
        {disabledReason && (
          <p className="mt-1.5 pl-6 text-[10.5px] leading-relaxed text-subtle">{disabledReason}</p>
        )}
        {exporting && (
          <KeyExportDialog address={address} keypair={keypair} onClose={() => setExporting(false)} />
        )}
        {confirmingRotate && (
          <RotateKeyDialog
            address={address}
            busy={busy}
            onClose={() => setConfirmingRotate(false)}
            onConfirm={async () => {
              setWorking(true)
              setError('')
              try {
                const gen = await generateKeySet({ email: address })
                await onRotate(keypairFromSet(gen))
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              } finally {
                setWorking(false)
                setConfirmingRotate(false)
              }
            }}
          />
        )}
      </div>
    )
  }

  // No key for this alias yet.
  return (
    <div className="rounded-md border border-dashed border-input p-3">
      <div className="flex items-center gap-2">
        <KeyIcon className="h-4 w-4 flex-none text-subtle" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{address}</span>
        {mode === 'idle' && (
          <div className="flex flex-none gap-2">
            <Button size="sm" onClick={() => void generateNow()} disabled={busy || working}>
              {working ? 'Generating…' : 'Generate'}
            </Button>
            <Button size="sm" onClick={() => setMode('import')} disabled={busy || working}>
              Import
            </Button>
          </div>
        )}
        {mode === 'import' && (
          <Button size="sm" onClick={() => setMode('idle')} disabled={working}>
            Cancel
          </Button>
        )}
      </div>

      {mode === 'import' && (
        <ImportKeyForm
          address={address}
          onSet={onInstall}
          onCancel={() => setMode('idle')}
          setError={setError}
        />
      )}
    </div>
  )
}
