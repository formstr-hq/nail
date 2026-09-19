import { useState } from 'react'
import type { PgpKeypair } from '@/app/lib/nostr/settings'
import { readKeyInfo, unlockPrivateKey, type KeyInfo } from '@/app/lib/pgp/openpgp'
import { Button } from '@/app/components/ui/Button'
import { areaClass, inputClass, extractPublicKey } from '@/app/components/settings/pgp/shared'

/**
 * Import an existing private key for one alias.
 *
 * Two steps when the pasted key is passphrase-protected: the user proves they
 * hold the passphrase, the key is unlocked, and the UNLOCKED armor is stored.
 * Mailstr's storage policy is passphrase-less keys (ADR-007), so the app never
 * persists a locked key — but importing one is legitimate (an export from the
 * app, or a GPG key), so the passphrase is asked for here rather than telling
 * the user to strip it in GPG first.
 */
export function ImportKeyForm({
  address,
  onSet,
  onCancel,
  setError,
}: {
  address: string
  /** Install the key (store + WKD publish); resolves true when installed. */
  onSet: (kp: PgpKeypair) => Promise<boolean>
  onCancel: () => void
  setError: (m: string) => void
}) {
  const [text, setText] = useState('')
  const [info, setInfo] = useState<KeyInfo | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [working, setWorking] = useState(false)

  async function store(armoredPrivate: string, keyInfo: KeyInfo) {
    const publicKey = await extractPublicKey(armoredPrivate)
    return onSet({
      publicKey,
      privateKey: armoredPrivate,
      fingerprint: keyInfo.fingerprint,
      passphraseProtected: false,
    })
  }

  async function inspect() {
    setWorking(true)
    setError('')
    try {
      const armored = text.trim()
      const keyInfo = await readKeyInfo(armored)
      if (!keyInfo.isPrivate) {
        throw new Error('That’s a public key — import your PRIVATE key so you can decrypt and sign.')
      }
      if (keyInfo.encrypted) {
        // Locked: ask for the passphrase before anything is stored.
        setInfo(keyInfo)
        return
      }
      if (await store(armored, keyInfo)) onCancel()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
    }
  }

  async function unlockAndStore() {
    if (!info || !passphrase) return
    setWorking(true)
    setError('')
    try {
      const unlocked = await unlockPrivateKey(text.trim(), passphrase)
      // Re-read the unlocked armor so the stored fingerprint/identity come from
      // what is actually persisted, not from the locked original.
      const unlockedInfo = await readKeyInfo(unlocked)
      // Only close when the key was actually installed — an install failure
      // (e.g. the WKD publish) leaves the form open with the key still pasted.
      if (await store(unlocked, unlockedInfo)) onCancel()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
    }
  }

  if (info) {
    return (
      <div className="mt-2 flex flex-col gap-2 pl-6">
        <p className="text-[11px] leading-relaxed text-subtle">
          This key is passphrase-protected. Enter its passphrase to unlock it — {address} is
          stored without a passphrase so Mailstr can decrypt and sign for you automatically.
        </p>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Key passphrase"
          className={inputClass}
          autoFocus
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={working || !passphrase}
            onClick={() => void unlockAndStore()}
          >
            {working ? 'Unlocking…' : 'Unlock & import'}
          </Button>
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-col gap-2 pl-6">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
        rows={4}
        className={areaClass}
      />
      <p className="text-[11px] leading-relaxed text-subtle">
        Paste the armored PRIVATE key for this address (e.g. exported from GPG or from this
        app). If it has a passphrase, you’ll be asked for it and the key is stored without one.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={working || !text.trim()}
          onClick={() => void inspect()}
        >
          {working ? 'Importing…' : 'Import key'}
        </Button>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
