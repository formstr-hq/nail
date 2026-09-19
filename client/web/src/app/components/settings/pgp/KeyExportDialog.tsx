import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyHalf, PgpKeypair } from '@/app/lib/nostr/settings'
import { encryptPrivateKey } from '@/app/lib/pgp/openpgp'
import { saveToDisk } from '@/app/lib/saveFile'
import { Button } from '@/app/components/ui/Button'
import { LockIcon } from '@/app/components/ui/icons'
import { inputClass } from '@/app/components/settings/pgp/shared'

/**
 * The export dialog: download the alias's private key half(s) as one armored
 * bundle, ALWAYS passphrase-encrypted.
 *
 * Mailstr stores keys unlocked (no passphrase), so a downloaded copy is the
 * only place a passphrase ever protects this key — and it must, or a bare
 * secret key would land on disk. The user therefore sets an EXPORT passphrase
 * here; it is independent of the stored key, which stays unlocked.
 *
 * A legacy passphrase-protected keypair downloads as-is, still locked with its
 * own original passphrase: re-encrypting it with a new one here would produce
 * a file whose passphrase had nothing to do with the key stored in settings.
 */
export function KeyExportDialog({
  address,
  keypair,
  onClose,
}: {
  address: string
  keypair: PgpKeypair
  onClose: () => void
}) {
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  // Every private half: dual halves when present, else the legacy single pair.
  const halves: Array<KeyHalf & { passphraseProtected?: boolean }> = [
    ...(keypair.v4 ? [keypair.v4] : []),
    ...(keypair.v6 ? [keypair.v6] : []),
  ]
  if (!halves.length) {
    halves.push({
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      fingerprint: keypair.fingerprint,
    })
  }

  async function download(bundle: string) {
    const safe = address.replace(/[^a-z0-9._-]/gi, '_')
    await saveToDisk(bundle, `${safe}-private-keys.asc`, 'application/pgp-keys')
  }

  async function doExportAsIs() {
    setWorking(true)
    setError('')
    try {
      await download(halves.map((h) => h.privateKey).join('\n'))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
    }
  }

  async function doExportWithNewPassphrase() {
    if (pass.length < 8) {
      setError('Use at least 8 characters — this passphrase is all that protects the file.')
      return
    }
    if (pass !== pass2) {
      setError('Passphrases do not match.')
      return
    }
    setWorking(true)
    setError('')
    try {
      const blocks: string[] = []
      for (const half of halves) {
        blocks.push(await encryptPrivateKey(half.privateKey, pass))
      }
      await download(blocks.join('\n'))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
    }
  }

  // Portaled to <body>: rendered inside the scrolling settings pane, this
  // overlay is subject to the pane's clipping/stacking in the native WebView
  // (its bottom lands behind the Settings footer). A body-level portal makes
  // it a true top-level modal.
  if (keypair.passphraseProtected) {
    return createPortal(
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/20 p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-2xl">
          <div className="flex items-center gap-2">
            <LockIcon className="h-4 w-4 flex-none text-muted-foreground" />
            <h3 className="flex-1 text-[13px] font-semibold text-foreground">Export private keys</h3>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
            Your private key{halves.length === 1 ? '' : 's'} for {address} {halves.length === 1 ? 'is' : 'are'}{' '}
            already passphrase-protected. The file downloads locked with that same passphrase —
            the one you use to unlock this key in this app.
          </p>
          {error && <p className="mt-2 text-[11.5px] text-destructive">{error}</p>}
          <Button
            variant="primary"
            className="mt-3 w-full"
            disabled={working}
            onClick={() => void doExportAsIs()}
          >
            {working ? 'Preparing…' : 'Download'}
          </Button>
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/20 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-2xl">
        <div className="flex items-center gap-2">
          <LockIcon className="h-4 w-4 flex-none text-muted-foreground" />
          <h3 className="flex-1 text-[13px] font-semibold text-foreground">Export private keys</h3>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          Your private key{halves.length === 1 ? '' : 's'} for {address} will be encrypted with
          this passphrase before download. The file is unusable without it — there is no
          recovery if you forget it.
        </p>
        <input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="Export passphrase (8+ characters)"
          className={inputClass + ' mt-3'}
          autoFocus
        />
        <input
          type="password"
          value={pass2}
          onChange={(e) => setPass2(e.target.value)}
          placeholder="Repeat passphrase"
          className={inputClass + ' mt-2'}
        />
        {error && <p className="mt-2 text-[11.5px] text-destructive">{error}</p>}
        <Button
          variant="primary"
          className="mt-3 w-full"
          disabled={working || !pass || !pass2}
          onClick={() => void doExportWithNewPassphrase()}
        >
          {working ? 'Encrypting…' : 'Download encrypted keys'}
        </Button>
      </div>
    </div>,
    document.body,
  )
}
