import { useEffect, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { useOwnedAddresses } from '@/hooks/useOwnedAddresses'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'
import type { PgpKeypair } from '@/lib/nostr/settings'
import { generateKey, readKeyInfo } from '@/lib/pgp/openpgp'
import { keyringKey, addToKeyring, removeFromKeyring, keyringEntries, type KeyringEntry } from '@/lib/pgp/keyring'
import { publishKey } from '@/lib/pgp/keyserver'
import { Button } from '@/components/ui/Button'
import { AlertIcon, KeyIcon, TrashIcon, PlusIcon } from '@/components/ui/icons'

/** Same labelled-block shape SettingsModal uses, kept local to avoid coupling. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="eyebrow">{label}</div>
      {hint && <p className="text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}

const inputClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] text-foreground placeholder:text-subtle focus:outline-none'
const areaClass =
  'w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] text-foreground placeholder:text-subtle focus:outline-none'

/**
 * The Encryption settings pane: manage a PGP key PER ALIAS plus the keyring of
 * correspondents' public keys.
 *
 * Keys are per-alias by design (settings.ts): one key bound to several
 * addresses would link them publicly, which is the opposite of what aliases are
 * for. So each owned address gets its own independent keypair, listed and
 * managed separately here.
 *
 * This owns its own persistence (through the settings store's `save`) rather
 * than folding into SettingsModal's single Save, because generating/importing a
 * key or editing the keyring is each a complete action the user expects to stick
 * immediately. Private keys ride in the same encrypted settings blob as every
 * other field.
 */
export function PgpSettings() {
  const { account, active } = useAccountStore()
  const { settings, save } = useSettingsStore()
  const { addresses } = useOwnedAddresses()

  const [entries, setEntries] = useState<KeyringEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Every address the user can hold a key for: owned NIP-05 names plus the
  // always-present npub bridge address.
  const bridgeAddress = account ? `${account.npub}@${BRIDGE_DOMAIN}` : ''
  const aliasList = [...addresses, ...(bridgeAddress ? [bridgeAddress] : [])]

  useEffect(() => {
    let alive = true
    void (async () => {
      const list = await keyringEntries(settings.pgpKeyring)
      if (alive) setEntries(list)
    })()
    return () => {
      alive = false
    }
  }, [settings.pgpKeyring])

  async function persist(patch: Parameters<typeof save>[0]) {
    if (!account || !active) {
      setError('Your session is locked — sign in again.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await save({ ...settings, ...patch }, account.pubkey, active)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function setAliasKey(address: string, keypair: PgpKeypair | null) {
    const next = { ...(settings.pgpKeys ?? {}) }
    if (keypair) next[keyringKey(address)] = keypair
    else delete next[keyringKey(address)]
    void persist({ pgpKeys: next })
  }

  return (
    <div className="flex flex-col gap-6">
      <Field
        label="Your keys"
        hint="A separate PGP key for each of your addresses — kept distinct so your aliases stay unlinked. Each is used to sign and decrypt mail for that address, and its private half is stored encrypted and synced with your other settings."
      >
        <div className="flex flex-col gap-2">
          {aliasList.length === 0 && (
            <p className="text-[11.5px] text-subtle">
              Set up an address first — keys are bound to an email identity.
            </p>
          )}
          {aliasList.map((address) => (
            <AliasKeyRow
              key={address}
              address={address}
              keypair={settings.pgpKeys?.[keyringKey(address)]}
              busy={busy}
              onSet={(kp) => setAliasKey(address, kp)}
              setError={setError}
            />
          ))}
        </div>
      </Field>

      <Field
        label="Correspondents’ keys"
        hint="Public keys of people you write to, found automatically when you compose or added by hand. You can only encrypt to someone once you hold their key."
      >
        <Keyring
          entries={entries}
          busy={busy}
          onAdd={async (armored, forAddress) => {
            const next = await addToKeyring(settings.pgpKeyring, armored, forAddress || undefined)
            await persist({ pgpKeyring: next })
          }}
          onRemove={(address) => void persist({ pgpKeyring: removeFromKeyring(settings.pgpKeyring, address) })}
          setError={setError}
        />
      </Field>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
          <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
          <p className="text-[11.5px] leading-relaxed text-destructive">{error}</p>
        </div>
      )}
    </div>
  )
}

/** One alias row: shows its key if it has one, else offers generate/import. */
function AliasKeyRow({
  address,
  keypair,
  busy,
  onSet,
  setError,
}: {
  address: string
  keypair: PgpKeypair | undefined
  busy: boolean
  onSet: (kp: PgpKeypair | null) => void
  setError: (m: string) => void
}) {
  const [mode, setMode] = useState<'idle' | 'generate' | 'import'>('idle')
  const [passphrase, setPassphrase] = useState('')
  const [importText, setImportText] = useState('')
  const [working, setWorking] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // Has a key — show fingerprint, copy, remove.
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
          {confirmRemove ? (
            <>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => onSet(null)}>
                Remove
              </Button>
              <Button size="sm" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
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
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Optional passphrase (extra protection at rest)"
            className={inputClass}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={working}
              onClick={async () => {
                setWorking(true)
                setError('')
                try {
                  const gen = await generateKey({ email: address, passphrase: passphrase || undefined })
                  onSet({
                    publicKey: gen.publicKey,
                    privateKey: gen.privateKey,
                    fingerprint: gen.fingerprint,
                    passphraseProtected: !!passphrase,
                  })
                  setMode('idle')
                  setPassphrase('')
                  // Publish the PUBLIC key so others can discover it and encrypt
                  // to this address. Best-effort — the keyserver emails a
                  // verification link; one click makes it searchable by email.
                  void publishKey(gen.publicKey, [address]).catch((e) =>
                    console.warn('[pgp] keyserver publish failed', e),
                  )
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
        <div className="mt-2 flex flex-col gap-2 pl-6">
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
            rows={4}
            className={areaClass}
          />
          <p className="text-[11px] leading-relaxed text-subtle">
            Paste the armored PRIVATE key for this address (e.g. exported from GPG).
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={working || !importText.trim()}
              onClick={async () => {
                setWorking(true)
                setError('')
                try {
                  const armoredPrivate = importText.trim()
                  const info = await readKeyInfo(armoredPrivate)
                  if (!info.isPrivate) {
                    throw new Error('That’s a public key — import your PRIVATE key so you can decrypt and sign.')
                  }
                  const publicKey = await extractPublicKey(armoredPrivate)
                  onSet({
                    publicKey,
                    privateKey: armoredPrivate,
                    fingerprint: info.fingerprint,
                    passphraseProtected: info.encrypted ?? false,
                  })
                  setMode('idle')
                  setImportText('')
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setWorking(false)
                }
              }}
            >
              {working ? 'Importing…' : 'Import key'}
            </Button>
            <Button size="sm" onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The correspondent keyring list + an add form. */
function Keyring({
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

/** Group a 40-hex fingerprint into the conventional space-separated blocks. */
function formatFingerprint(fp: string): string {
  return fp.toUpperCase().replace(/(.{4})/g, '$1 ').trim()
}

/** Re-armor just the public half of an armored private key. */
async function extractPublicKey(armoredPrivate: string): Promise<string> {
  const openpgp = await import('openpgp')
  const key = await openpgp.readPrivateKey({ armoredKey: armoredPrivate })
  return key.toPublic().armor()
}
