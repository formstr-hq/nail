import type { Attachment } from '@/app/types/mail'
import { ATTACHMENT_LINKS_START } from '@protocol'
import {
  ATTACHMENTS_TXT_FILENAME,
  parseAttachmentsTxt,
} from './attachmentLinks'

/** The shape postal-mime hands back; imported structurally to avoid a dep. */
export type ParsedMimeAttachment = {
  filename?: string | null
  mimeType?: string
  content: ArrayBuffer | Uint8Array | string
}

function contentBytes(content: ParsedMimeAttachment['content']): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content)
  return new Uint8Array(
    content instanceof Uint8Array ? content : new Uint8Array(content),
  )
}

/** MIME attachments carried inline in the message itself. */
export function inlineAttachments(
  parsed: ParsedMimeAttachment[] | undefined,
): Attachment[] {
  return (parsed ?? []).map((a) => {
    const data = contentBytes(a.content)
    return {
      filename: a.filename ?? 'attachment',
      contentType: a.mimeType ?? 'application/octet-stream',
      size: data.byteLength,
      data,
    }
  })
}

/**
 * Splits a parsed MIME attachment list into real files and the synthetic
 * `attachments.txt` list. The txt file is never shown as a download; its
 * share links become normal attachment chips instead.
 */
export function splitMimeAttachments(
  parsed: ParsedMimeAttachment[] | undefined,
): { inline: Attachment[]; shared: Attachment[] } {
  const atts = parsed ?? []
  const linkFile = atts.find((a) => {
    if ((a.filename ?? '').toLowerCase() === ATTACHMENTS_TXT_FILENAME.toLowerCase()) {
      return true
    }
    // Match by content too, so the sender can give the file a friendlier name.
    if (!(a.mimeType ?? '').startsWith('text/')) return false
    const text =
      typeof a.content === 'string'
        ? a.content
        : new TextDecoder().decode(
            a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content),
          )
    return text.includes(ATTACHMENT_LINKS_START)
  })
  const rest = atts.filter((a) => a !== linkFile)
  return {
    inline: inlineAttachments(rest),
    shared: linkFile ? parseAttachmentsTxt(linkFile.content) : [],
  }
}
