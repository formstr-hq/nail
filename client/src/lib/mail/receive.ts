import type { Event } from 'nostr-tools'
import { unwrapGiftWrap } from '@/lib/nostr/giftwrap'
import type { Signer } from '@/lib/nostr/signer'
import { parseRfc2822 } from './rfc2822'
import { KIND_MAIL } from '@/lib/nostr/constants'
import type { Email } from '@/types/mail'

export async function decodeGiftWrap(
  event: Event,
  signer: Signer,
): Promise<Email | null> {
  const rumor = await unwrapGiftWrap(event, signer)
  if (!rumor || rumor.kind !== KIND_MAIL) return null

  try {
    const parsed = await parseRfc2822(rumor.content)

    // A bare npub in a To:/CC: header is not a valid addr-spec, so the parser
    // reports it as a display name with an empty address. Fall back to the
    // name so mail sent before headers carried `<npub>@<domain>` still shows a
    // recipient instead of a blank field.
    const toDisplay = (a: { name?: string; address?: string }) => ({
      name: a.address ? a.name : undefined,
      address: a.address || a.name || '',
    })

    const toAddresses = (parsed.to ?? []).map(toDisplay)
    const ccAddresses = (parsed.cc ?? []).map(toDisplay)

    return {
      id: event.id,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references?.split(/\s+/).filter(Boolean),
      from: {
        name: parsed.from?.name,
        address: parsed.from?.address ?? rumor.pubkey,
      },
      to: toAddresses,
      cc: ccAddresses.length ? ccAddresses : undefined,
      subject: parsed.subject ?? '(no subject)',
      body: parsed.text ?? '',
      bodyHtml: parsed.html ?? undefined,
      attachments: (parsed.attachments ?? []).map((a) => {
        const content = a.content
        const isBuffer = content instanceof ArrayBuffer || (content && typeof content === 'object' && 'byteLength' in content)
        return {
          filename: a.filename ?? 'attachment',
          contentType: a.mimeType ?? 'application/octet-stream',
          size: isBuffer ? (content as ArrayBuffer).byteLength : 0,
          data: isBuffer ? new Uint8Array(content as ArrayBuffer) : undefined,
        }
      }),
      timestamp: rumor.created_at,
      senderPubkey: rumor.pubkey,
      read: false,
      labelEventIds: [],
      labels: [],
    }
  } catch {
    return null
  }
}
