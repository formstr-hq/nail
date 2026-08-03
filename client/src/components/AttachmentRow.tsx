import { useState } from 'react'
import type { Attachment } from '@/types/mail'
import { resolveAttachment, saveToDisk, formatSize } from '@/lib/mail/attachments'
import { PaperclipIcon, AlertIcon } from '@/components/ui/icons'
import { Button } from '@/components/ui/Button'

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
      saveToDisk(bytes, attachment.filename, attachment.contentType)
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
          {readableSize ?? (inline ? '' : 'size unknown')}
        </span>
        <span className="flex-1" />
        <Button size="sm" onClick={download} disabled={busy} className="flex-none">
          {busy ? 'Downloading…' : 'Download'}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-1.5">
          <AlertIcon className="mt-px h-3 w-3 flex-none text-destructive" />
          <p className="text-[11px] leading-relaxed text-destructive">{error}</p>
        </div>
      )}

      {!inline && !error && (
        // Downloading contacts a host the sender chose, which reveals the
        // reader's IP. Say so before they click rather than after.
        <p className="pl-[1.375rem] text-[10.5px] leading-relaxed text-subtle">
          Stored outside the message. Downloading contacts the sender's host.
        </p>
      )}
    </div>
  )
}
