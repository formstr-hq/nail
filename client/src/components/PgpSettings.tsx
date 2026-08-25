import { useEffect, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { useOwnedAddresses } from '@/hooks/useOwnedAddresses'
import { generateKey, readKeyInfo, type KeyInfo } from '@/lib/pgp/openpgp'
import { addToKeyring, removeFromKeyring, keyringEntries, type KeyringEntry } from '@/lib/pgp/keyring'
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
 * The Encryption settings pane: manage the user's own OpenPGP key and the
 * keyring of correspondents' public keys.
 *
 * This owns its own persistence (through the settings store's `save`) rather
 * than folding into SettingsModal's single Save, because a keyring add/remove
 * and a key generate/import are each a complete action the user expects to
 * stick immediately — not something staged behind a modal-wide Save they might
 * cancel. The private key rides in the same encrypted settings blob as every
 * other field.
 */
export function PgpSettings() {
  const { account, active } = useAccountStore()
  const { settings, save } = useSettingsStore()
  const { addresses } = useOwnedAddresses()

  const [ownInfo, setOwnInfo] = useState<KeyInfo | null>(null)
  const [entries, setEntries] = useState<KeyringEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Decode the stored own-key and keyring for display whenever they change.
  useEffect(() => {
    let alive = true
    void (async () => {
      if (settings.pgpPublicKey) {
        try {
          if (alive) setOwnInfo(await readKeyInfo(settings.pgpPublicKey))
        } catch {
          if (alive) setOwnInfo(null)
        }
      } else if (alive) {
        setOwnInfo(null)
      }
      const list = await keyringEntries(settings.pgpKeyring)
      if (alive) setEntries(list)
    })()
    return () => {
      alive = false
    }
  }, [settings.pgpPublicKey, settings.pgpKeyring])

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

  // The address a generated key is bound to: the saved sender, else the first
  // owned address. Without one we can't mint a key that identifies the user.
  const identityAddress = settings.senderAddress ?? addresses[0]

  return (
    <div className="flex flex-col gap-6">
      <Field
        label="Your PGP key"
        hint="Used to encrypt and sign mail to people who use PGP, and to decrypt PGP mail sent to you. Your private key is stored encrypted and synced with your other settings — it never leaves in the clear."
      >
        {ownInfo ? (
          <OwnKey info={ownInfo} armoredPublic={settings.pgpPublicKey!} onRemove={() =>
            void persist({ pgpPublicKey: undefined, pgpPrivateKey: undefined, pgpPassphraseProtected: undefined })
          } busy={busy} />
        ) : (
          <NoOwnKey
            identityAddress={identityAddress}
            busy={busy}
            onGenerate={(gen) =>
              void persist({
                pgpPublicKey: gen.publicKey,
                pgpPrivateKey: gen.privateKey,
                pgpPassphraseProtected: gen.passphraseProtected,
              })
            }
            onImport={(pub, priv, locked) =>
              void persist({ pgpPublicKey: pub, pgpPrivateKey: priv, pgpPassphraseProtected: locked })
            }
            setError={setError}
          />
        )}
      </Field>

      <Field
        label="Correspondents’ keys"
        hint="Public keys of people you write to. You can only encrypt to someone once you hold their key. Paste an armored public key to add one."
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

/** Shown when the user already has a key: fingerprint, export, remove. */
function OwnKey({
  info,
  armoredPublic,
  onRemove,
  busy,
}: {
  info: KeyInfo
  armoredPublic: string
  onRemove: () => void
  busy: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-input bg-muted/40 p-3">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
          <KeyIcon className="h-4 w-4 flex-none text-muted-foreground" />
          {info.userIDs[0] ?? info.emails[0] ?? 'your key'}
        </div>
        <div className="mt-1 break-all font-mono text-[10.5px] text-subtle">
          {formatFingerprint(info.fingerprint)}
        </div>
        {info.encrypted && (
          <div className="mt-1 text-[10.5px] text-muted-foreground">Passphrase-protected</div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(armoredPublic).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'Copied public key' : 'Copy public key'}
        </Button>
        {confirmRemove ? (
          <>
            <span className="self-center text-[11.5px] text-muted-foreground">
              Remove this key from all your devices?
            </span>
            <Button size="sm" variant="danger" onClick={onRemove} disabled={busy}>
              Remove
            </Button>
            <Button size="sm" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setConfirmRemove(true)}>
            Remove key
          </Button>
        )}
      </div>
    </div>
  )
}

/** Shown when there's no key yet: generate one, or import an existing one. */
function NoOwnKey({
  identityAddress,
  busy,
  onGenerate,
  onImport,
  setError,
}: {
  identityAddress: string | undefined
  busy: boolean
  onGenerate: (gen: { publicKey: string; privateKey: string; passphraseProtected: boolean }) => void
  onImport: (pub: string, priv: string, locked: boolean) => void
  setError: (m: string) => void
}) {
  const [mode, setMode] = useState<'idle' | 'generate' | 'import'>('idle')
  const [passphrase, setPassphrase] = useState('')
  const [importText, setImportText] = useState('')
  const [working, setWorking] = useState(false)

  if (mode === 'idle') {
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setMode('generate')} disabled={busy}>
          Generate a key
        </Button>
        <Button size="sm" onClick={() => setMode('import')} disabled={busy}>
          Import a key
        </Button>
      </div>
    )
  }

  if (mode === 'generate') {
    return (
      <div className="flex flex-col gap-2">
        {!identityAddress && (
          <p className="text-[11.5px] text-destructive">
            Set a sender address first — a key is bound to your email identity.
          </p>
        )}
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
            disabled={!identityAddress || working}
            onClick={async () => {
              if (!identityAddress) return
              setWorking(true)
              setError('')
              try {
                const gen = await generateKey({ email: identityAddress, passphrase: passphrase || undefined })
                onGenerate({
                  publicKey: gen.publicKey,
                  privateKey: gen.privateKey,
                  passphraseProtected: !!passphrase,
                })
                setMode('idle')
                setPassphrase('')
                // Publish the PUBLIC key to the keyserver so others can discover
                // it and encrypt to this user. Best-effort: a failure here never
                // undoes the (already saved) key — it just means the user isn't
                // discoverable yet. The keyserver emails a verification link to
                // the address; one click makes it searchable by email.
                void publishKey(gen.publicKey, [identityAddress]).catch((e) =>
                  console.warn('[pgp] keyserver publish failed', e),
                )
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              } finally {
                setWorking(false)
              }
            }}
          >
            {working ? 'Generating…' : 'Generate'}
          </Button>
          <Button size="sm" onClick={() => setMode('idle')}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  // import
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
        placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
        rows={4}
        className={areaClass}
      />
      <p className="text-[11px] leading-relaxed text-subtle">
        Paste your armored PRIVATE key (e.g. exported from GPG). It’s stored encrypted with your
        other settings.
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
              // Store both halves: the public key derived from the private, so
              // the common keyring/read paths never parse the secret.
              const publicKey = await extractPublicKey(armoredPrivate)
              onImport(publicKey, armoredPrivate, info.encrypted ?? false)
              setMode('idle')
              setImportText('')
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            } finally {
              setWorking(false)
            }
          }}
        >
          {working ? 'Importing…' : 'Import'}
        </Button>
        <Button size="sm" onClick={() => setMode('idle')}>
          Cancel
        </Button>
      </div>
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
