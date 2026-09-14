import { useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { saveToDisk } from '@/app/lib/saveFile'
import { Button } from '@/app/components/ui/Button'
import { Field } from '@/app/components/settings/Field'

/**
 * Re-exposes the account's NIP-49 encrypted key so a user who clicked past the
 * one-time backup at signup can still save it. The string is already
 * passphrase-encrypted, but we gate the reveal and warn hard: with the
 * passphrase it reconstructs the entire mailbox on any device, and nothing else
 * — no reset, no support — can. External-signer accounts keep their key in the
 * signer, so there's nothing to export here.
 */
export function KeyBackupSection() {
  const account = useAccountStore((s) => s.account)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!account) return null

  if (account.method !== 'ncryptsec' || !account.ncryptsec) {
    return (
      <Field label="Key backup" hint="This account's key isn't stored in the app.">
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          You signed in with an external signer, so your private key lives
          there, not here — back it up wherever that signer keeps it.
        </p>
      </Field>
    )
  }

  const ncryptsec = account.ncryptsec

  const copy = () => {
    void navigator.clipboard.writeText(ncryptsec).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const download = () => {
    void saveToDisk(
      `${ncryptsec}\n`,
      `mailstr-key-${account.npub.slice(4, 16)}.txt`,
      'text/plain',
    ).catch(console.error)
  }

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Back up your key"
        hint="Your account is this key — there's no password or email reset behind it."
      >
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12px] leading-relaxed text-muted-foreground">
          Below is your private key, encrypted with your passphrase (NIP-49).
          Save it somewhere safe and keep your passphrase. With both you can
          restore your mailbox on any device; lose either and no one — including
          us — can recover it.
        </div>
      </Field>

      <div
        className={`break-all rounded-md border border-input bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground ${
          revealed ? '' : 'select-none blur-sm'
        }`}
      >
        {ncryptsec}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setRevealed((v) => !v)}>
          {revealed ? 'Hide' : 'Reveal'}
        </Button>
        <Button variant="secondary" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="secondary" onClick={download}>
          Download
        </Button>
      </div>
    </div>
  )
}