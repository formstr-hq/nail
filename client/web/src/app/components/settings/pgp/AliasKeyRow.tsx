import { useState } from 'react'
import type { KeyHalf, PgpKeypair } from '@/app/lib/nostr/settings'
import { generateKeySet } from '@/app/lib/pgp/openpgp'
import { ownPublicKeysFor } from '@/app/lib/pgp/keyring'
import { Button } from '@/app/components/ui/Button'
import { KeyIcon } from '@/app/components/ui/icons'
import { formatFingerprint } from '@/app/components/settings/pgp/shared'
import { publishOwnKey, republishOwnKey } from '@/app/components/settings/pgp/wkdPublish'
import { KeyExportDialog } from '@/app/components/settings/pgp/KeyExportDialog'
import { RotateKeyDialog } from '@/app/components/settings/pgp/RotateKeyDialog'
import { ImportKeyForm } from '@/app/components/settings/pgp/ImportKeyForm'

/** One alias row: shows its key if it has one, else offers generate/import. */
export function AliasKeyRow({
  address,
  keypair,
  busy,
  onSet,
  onRotate,
  setError,
}: {
  address: string
  keypair: PgpKeypair | undefined
  busy: boolean
  onSet: (kp: PgpKeypair) => void
  /** Replace this alias's keypair (generate → save → WKD publish). */
  onRotate: () => Promise<void>
  setError: (m: string) => void
}) {
  const [mode, setMode] = useState<'idle' | 'generate' | 'import'>('idle')
  const [working, setWorking] = useState(false)
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [republishing, setRepublishing] = useState(false)
  const [republished, setRepublished] = useState(false)
  const [confirmingRotate, setConfirmingRotate] = useState(false)

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
        </div>
        {exporting && (
          <KeyExportDialog address={address} keypair={keypair} onClose={() => setExporting(false)} />
        )}
        {confirmingRotate && (
          <RotateKeyDialog
            address={address}
            busy={busy}
            onClose={() => setConfirmingRotate(false)}
            onConfirm={() => {
              void onRotate().finally(() => setConfirmingRotate(false))
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
            <Button size="sm" onClick={() => setMode('generate')} disabled={busy}>
              Generate
            </Button>
            <Button size="sm" onClick={() => setMode('import')} disabled={busy}>
              Import
            </Button>
          </div>
        )}
      </div>

      {mode === 'generate' && (
        <div className="mt-2 flex flex-col gap-2 pl-6">
          <p className="text-[10.5px] leading-relaxed text-subtle">
            Generates a dual key set — a v4 (GnuPG-compatible) key plus a v6 key — so every
            mail service can write to you encrypted. The key is stored without a passphrase:
            Mailstr needs it unlocked to decrypt and sign automatically. Use Export any time
            to download a passphrase-protected backup copy.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={working}
              onClick={async () => {
                setWorking(true)
                setError('')
                try {
                  const gen = await generateKeySet({ email: address })
                  const halves: Record<'v4' | 'v6', KeyHalf> = {
                    v4: { publicKey: gen.v4.publicKey, privateKey: gen.v4.privateKey, fingerprint: gen.v4.fingerprint },
                    v6: { publicKey: gen.v6.publicKey, privateKey: gen.v6.privateKey, fingerprint: gen.v6.fingerprint },
                  }
                  onSet({
                    publicKey: gen.v4.publicKey,
                    privateKey: gen.v4.privateKey,
                    fingerprint: gen.v4.fingerprint,
                    passphraseProtected: false,
                    v4: halves.v4,
                    v6: halves.v6,
                  })
                  setMode('idle')
                  // Publish BOTH public keys so others can discover them and
                  // encrypt to this address. Best-effort, never blocks
                  // generation.
                  publishOwnKey(address, [gen.v4.publicKey, gen.v6.publicKey])
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setWorking(false)
                }
              }}
            >
              {working ? 'Generating…' : 'Generate key'}
            </Button>
            <Button size="sm" onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === 'import' && (
        <ImportKeyForm
          address={address}
          onSet={onSet}
          onCancel={() => setMode('idle')}
          setError={setError}
        />
      )}
    </div>
  )
}
