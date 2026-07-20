import type { Event } from 'nostr-tools'
import { unwrapAndVerify, messageStringToBytes, type ProtocolSigner } from '@protocol'
import { parseRfc2822 } from './rfc2822'
import type { Email } from '@/types/mail'

export interface DecodeFailure {
  reason: string
  /** True when this is routine — a wrap that simply is not ours to read. */
  routine: boolean
}

export type DecodeResult = { email: Email } | { failure: DecodeFailure }

/**
 * Decode one gift wrap into a displayable email.
 *
 * The trust rule is the important part. RFC 2822 `From:` is only authoritative
 * when the configured bridge sealed the message — the bridge is what verified
 * the sender's identity upstream. For any other sealer the headers are just
 * text the sender chose, so the sender IS the sealing key. Without this,
 * anyone could gift-wrap a message claiming `From: ceo@company.com`.
 */
export async function decodeGiftWrap(
  event: Event,
  signer: ProtocolSigner,
  bridgePubkey: string | null,
): Promise<DecodeResult> {
  // No staleness bound here: unlike the bridge, a mailbox legitimately shows
  // mail from months ago, and the replay concern (re-relaying a message) does
  // not apply to rendering one.
  const result = await unwrapAndVerify(event, signer, { maxAgeSeconds: Infinity })

  if (!result.ok) {
    return { failure: { reason: result.reason, routine: result.reason === 'not-for-us' } }
  }

  const { seal, rumor } = result

  try {
    // §4: content is a byte string. postal-mime must be handed real bytes —
    // given a string it re-encodes to UTF-8 before applying the declared
    // charset, which mojibakes every non-UTF-8 message.
    const parsed = await parseRfc2822(messageStringToBytes(rumor.content))

    const bridgeSealed = bridgePubkey !== null && seal.pubkey === bridgePubkey
    const fromAddress = bridgeSealed ? parsed.from?.address ?? seal.pubkey : seal.pubkey

    const toDisplay = (a: { name?: string; address?: string }) => ({
      name: a.address ? a.name : undefined,
      address: a.address || a.name || '',
    })

    const ccAddresses = (parsed.cc ?? []).map(toDisplay)

    return {
      email: {
        id: event.id,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references?.split(/\s+/).filter(Boolean),
        from: { name: bridgeSealed ? parsed.from?.name : undefined, address: fromAddress },
        to: (parsed.to ?? []).map(toDisplay),
        cc: ccAddresses.length ? ccAddresses : undefined,
        subject: parsed.subject ?? '(no subject)',
        body: parsed.text ?? '',
        bodyHtml: parsed.html ?? undefined,
        // Attachments are out of scope for this pass. Surface that they exist
        // rather than dropping them silently, so a user is never unaware that
        // a message carried one.
        attachments: (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? 'attachment',
          contentType: a.mimeType ?? 'application/octet-stream',
          size: 0,
          data: undefined,
        })),
        timestamp: rumor.created_at,
        senderPubkey: seal.pubkey,
        read: false,
        labelEventIds: [],
        labels: [],
      },
    }
  } catch (err) {
    return {
      failure: { reason: `rfc2822 parse failed: ${(err as Error).message}`, routine: false },
    }
  }
}
