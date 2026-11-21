import { useState } from 'react'
import type { Email } from '@/app/types/mail'
import { useAccountStore } from '@/app/store/account'
import { useMailStore } from '@/app/store/mail'
import { fetchRemoteMessage, decodeRemoteEmail } from '@/app/lib/mail/remoteMessage'
import { formatSize } from '@/app/lib/mail/attachments'
import { AlertIcon, CloudIcon } from '@/app/components/ui/icons'
import { Button } from '@/app/components/ui/Button'

/**
 * A large message is represented by a small pointer in the mailbox. The full
 * RFC 822 body is lazily downloaded and decrypted on demand; once it arrives we
 * replace the pointer in the store so Reply/Forward and search see the real
 * content.
 */
export function RemoteMessageCard({ email }: { email: Email }) {
  const account = useAccountStore((s) => s.account)
  const active = useAccountStore((s) => s.active)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const remote = email.remote

  if (!remote || remote.loaded) return null

  async function load() {
    setBusy(true)
    setError('')
    try {
      const bytes = await fetchRemoteMessage(remote!, active)
      const full = await decodeRemoteEmail(email, bytes, account?.pubkey ?? null)
      useMailStore.getState().upsertEmail(full)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-[68ch] flex-col gap-3 rounded-md border border-border bg-card p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex-none text-primary">
          <CloudIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">
            Large message stored remotely
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
            This {formatSize(remote.size) ?? 'large'} message is encrypted and kept on
            Blossom to avoid splitting it across hundreds of relay events. Download it to
            read the full content.
          </p>
        </div>
      </div>
      <Button onClick={() => void load()} disabled={busy} className="self-start">
        {busy ? 'Downloading…' : 'Download full message'}
      </Button>
      {error && (
        <div className="flex items-start gap-1.5">
          <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
          <p className="text-[11.5px] leading-relaxed text-destructive">{error}</p>
        </div>
      )}
    </div>
  )
}
