import { useState } from 'react'
import type { Attachment } from '@/app/types/mail'
import { resolveAttachment, saveToDisk, formatSize } from '@/app/lib/mail/attachments'
import { PaperclipIcon, AlertIcon } from '@/app/components/ui/icons'
import { Button } from '@/app/components/ui/Button'

/**
 * One attachment, with its own download state.
 *
 * State is per-row rather than per-message because a Blossom fetch can fail on
 * its own — a dead host or a failed integrity check on one file says nothing
 * about the others.
 */
export function AttachmentRow({ attachment }: { attachment: Attachment }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [size, setSize] = useState(attachment.size)

  const inline = Boolean(attachment.data)
  const readableSize = formatSize(size)

  async function download() {
    setBusy(true)
    setError('')
    try {
      const bytes = await resolveAttachment(attachment)
      // A hosted file only reveals its size once fetched; keep it on screen.
      setSize(bytes.byteLength)
      await saveToDisk(bytes, attachment.filename, attachment.contentType)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <PaperclipIcon className="h-3.5 w-3.5 flex-none text-subtle" />
        <span className="truncate text-[12px] text-foreground" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="flex-none font-mono text-[10px] text-subtle">
          {readableSize ?? (inline ? '' : attachment.shareUrl ? 'Formstr Drive' : 'size unknown')}
        </span>
        <span className="flex-1" />
        {attachment.shareUrl ? (
          <a
            href={attachment.shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this attachment in Formstr Drive"
            className="inline-flex h-7 flex-none items-center justify-center whitespace-nowrap rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground transition-colors duration-[120ms] hover:bg-accent"
          >
            Open in Formstr Drive
          </a>
        ) : (
          <Button size="sm" onClick={download} disabled={busy} className="flex-none">
            {busy ? 'Downloading…' : 'Download'}
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-1.5">
          <AlertIcon className="mt-px h-3 w-3 flex-none text-destructive" />
          <p className="text-[11px] leading-relaxed text-destructive">{error}</p>
        </div>
      )}

      {!inline && !error && (
        <p className="pl-[1.375rem] text-[10.5px] leading-relaxed text-subtle">
          {attachment.shareUrl
            ? 'Stored in Formstr Drive. Opens in a new tab to preview or download.'
            : "Stored outside the message. Downloading contacts the sender's host."}
        </p>
      )}
    </div>
  )
}
