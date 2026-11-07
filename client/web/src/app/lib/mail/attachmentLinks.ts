import type { Attachment } from '@/app/types/mail'
import {
  ATTACHMENT_LINKS_END,
  ATTACHMENT_LINKS_START,
  ATTACHMENTS_TXT_FILENAME,
} from '@protocol'

/**
 * The plain-text link list that travels in `attachments.txt`.
 *
 * A full share URL is `https://drive.formstr.app/#shared=<naddr>&k=<hex>`; the
 * drive app opens it directly. Mailstr clients parse it back into ordinary
 * attachment chips that hand the reader to Formstr Drive, so the reader never
 * sees the raw list.
 */
export interface AttachmentShareLink {
  filename: string
  url: string
}

export { ATTACHMENTS_TXT_FILENAME }

const HTML_START = '<!-- mailstr-attachments-start -->'
const HTML_END = '<!-- mailstr-attachments-end -->'
const SHARE_URL = /https?:\/\/\S+#shared=\S+/

/** Decodes the `attachments.txt` MIME part into real attachment chips. */
export function parseAttachmentsTxt(
  content: ArrayBuffer | Uint8Array | string,
): Attachment[] {
  const text =
    typeof content === 'string'
      ? content
      : new TextDecoder().decode(
          content instanceof Uint8Array ? content : new Uint8Array(content),
        )
  return parseAttachmentLinks(text).attachments
}

/**
 * Removes our link list from a body and turns each entry into an `Attachment`
 * with a `shareUrl`. The attachment is resolved on download, so the reader
 * sees a normal chip instead of a literal URL list.
 *
 * A block with no valid share links is left in place: the markers may be
 * ordinary text someone typed, and deleting it would lose their words.
 */
export function parseAttachmentLinks(text: string): {
  body: string
  attachments: Attachment[]
} {
  const start = text.indexOf(ATTACHMENT_LINKS_START)
  const end = text.indexOf(ATTACHMENT_LINKS_END, start)
  if (start === -1 || end === -1) return { body: text, attachments: [] }

  const block = text.slice(start + ATTACHMENT_LINKS_START.length, end)
  const attachments: Attachment[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = SHARE_URL.exec(line)
    if (!match) continue
    const url = match[0]
    const filename = line
      .slice(0, match.index)
      .replace(/^[-*]\s*/, '')
      .replace(/:\s*$/, '')
      .trim()
    if (!filename) continue
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') continue
    } catch {
      continue
    }
    attachments.push({
      filename,
      contentType: 'application/octet-stream',
      shareUrl: url,
    })
  }

  if (!attachments.length) return { body: text, attachments: [] }

  const before = text.slice(0, start).trimEnd()
  const after = text.slice(end + ATTACHMENT_LINKS_END.length).trimStart()
  return {
    body: `${before}${after ? `\n\n${after}` : ''}`.trimEnd(),
    attachments,
  }
}

/** Removes the HTML link list, when the sender included one. */
export function stripAttachmentLinksHtml(html: string | undefined): string | undefined {
  if (!html) return html
  const start = html.indexOf(HTML_START)
  const end = html.indexOf(HTML_END, start)
  if (start === -1 || end === -1) return html
  return (html.slice(0, start) + html.slice(end + HTML_END.length)).trim()
}
