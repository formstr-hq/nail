import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/app/components/ui/Button'
import { AlertIcon, KeyIcon } from '@/app/components/ui/icons'

/**
 * Rotation confirmation. Rotation REPLACES the alias's keypair, so every
 * message previously encrypted to this address becomes unreadable in this app
 * — the old private half is gone and PGP ciphertext cannot be re-opened
 * without it. That is the one consequence a user cannot discover after the
 * fact, so it is stated before the action, not after.
 *
 * The old key cannot be recovered: it lives only in the settings blob this
 * operation overwrites. Export-before-rotate is the documented mitigation
 * (the caller offers the existing export dialog).
 *
 * Portaled to <body> for the same reason as KeyExportDialog: inside the
 * settings pane a fixed overlay is clipped by the WebView's scrolling stack.
 */
export function RotateKeyDialog({
  address,
  busy,
  onConfirm,
  onClose,
}: {
  address: string
  /** True while the rotation is in flight; the primary action disables. */
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const [exported, setExported] = useState(false)

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/30 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-2xl">
        <div className="flex items-center gap-2">
          <KeyIcon className="h-4 w-4 flex-none text-muted-foreground" />
          <h3 className="flex-1 text-[13px] font-semibold text-foreground">Rotate key for {address}</h3>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
          <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
          <p className="text-[11.5px] leading-relaxed text-destructive">
            You will not be able to view your previous messages encrypted to {address}.
          </p>
        </div>

        <ul className="mt-3 flex flex-col gap-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          <li>
            A new key replaces the current one everywhere: new mail is encrypted with it, and the
            public key published for {address} is overwritten.
          </li>
          <li>
            Messages already encrypted to the old key stay encrypted — nothing can decrypt them
            after the old private key is gone.
          </li>
          <li>Plaintext mail in your mailbox is unaffected.</li>
        </ul>

        <label className="mt-3 flex cursor-pointer items-start gap-2 text-[11.5px] leading-relaxed text-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={exported}
            onChange={(e) => setExported(e.target.checked)}
          />
          <span>
            I understand the old key cannot be recovered. Back it up first if I may need to read old
            messages — Export still offers a copy until I rotate.
          </span>
        </label>

        <Button
          variant="danger"
          className="mt-3 w-full"
          disabled={busy || !exported}
          onClick={onConfirm}
        >
          {busy ? 'Rotating…' : 'Rotate key'}
        </Button>
      </div>
    </div>,
    document.body,
  )
}
