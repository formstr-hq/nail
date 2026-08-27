import type { Event } from 'nostr-tools'
import {
  unwrapAndVerify,
  messageStringToBytes,
  parseImetaTags,
  KIND_MAIL,
  KIND_DELIVERY_RECEIPT,
  type ProtocolSigner,
} from '@protocol'
import { nip19 } from 'nostr-tools'
import { probeNip05 } from '@/lib/nostr/nip05'
import { fetchProfileName } from '@/lib/nostr/profile'
import { parseRfc2822 } from './rfc2822'
import type { Attachment, Email, SenderProof } from '@/types/mail'

/** The shape postal-mime hands back; imported structurally to avoid a dep. */
type ParsedAttachment = {
  filename?: string | null
  mimeType?: string
  content: ArrayBuffer | Uint8Array | string
}

export interface DecodeFailure {
  reason: string
  /** True when this is routine — a wrap that simply is not ours to read. */
  routine: boolean
}

/** A bridge delivery receipt: the bridge confirming it relayed one of our sent
 * messages onward. Not mail — it carries the delivered message's Message-ID so
 * the sender's client can mark the matching Sent copy as delivered. */
export interface DeliveryReceipt {
  messageId?: string
  deliveredTo?: string[]
}

export type DecodeResult =
  | { email: Email }
  | { receipt: DeliveryReceipt }
  | { failure: DecodeFailure }

/**
 * May we display the RFC 2822 `From:` header as the sender, and on what basis?
 *
 * Headers are just text the sender chose, so believing them unconditionally
 * would let anyone gift-wrap a message claiming `From: ceo@company.com`. Each
 * branch below is a case where the claim is actually backed by something:
 *
 *  - the bridge sealed it, and the bridge refuses to relay a `From` the
 *    sending key does not own (that check is the whole point of §5);
 *  - we sealed it ourselves, so it is our own outgoing copy;
 *  - the address's NIP-05 record resolves to the sealing key, which is the
 *    same proof the bridge performs, done here directly.
 *
 * Anything else falls back to the sealing pubkey, which is the only identity
 * we can actually verify.
 *
 * Returns which check succeeded rather than a bare boolean: the mailbox shows
 * the basis to the reader, and "the bridge vouched for this" is a different
 * claim from "this address's NIP-05 resolves to the sealing key".
 */
async function establishSenderProof(params: {
  fromAddress: string | undefined
  sealPubkey: string
  bridgePubkey: string | null
  ownPubkey: string | null
}): Promise<SenderProof> {
  const { fromAddress, sealPubkey, bridgePubkey, ownPubkey } = params
  if (!fromAddress) return 'none'
  if (bridgePubkey !== null && sealPubkey === bridgePubkey) return 'bridge-seal'
  if (ownPubkey !== null && sealPubkey === ownPubkey) return 'own-seal'

  // Cached and bounded; a miss or a timeout just means we show the pubkey.
  return (await probeNip05(fromAddress)) === sealPubkey ? 'nip05' : 'none'
}

/**
 * MIME parts carried in the message body itself.
 *
 * postal-mime types `content` as a union, so normalise to bytes here rather
 * than leaving every consumer to guess which shape it got. A string only
 * appears when the parser was asked for an encoding we do not request, so it
 * is decoded as UTF-8 rather than dropped.
 */
function inlineAttachments(parsed: ParsedAttachment[] | undefined): Attachment[] {
  return (parsed ?? []).map((a) => {
    const data =
      typeof a.content === 'string'
        ? new TextEncoder().encode(a.content)
        : new Uint8Array(a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content))
    return {
      filename: a.filename ?? 'attachment',
      contentType: a.mimeType ?? 'application/octet-stream',
      size: data.byteLength,
      data,
    }
  })
}

/**
 * Attachments too large to inline, offloaded to Blossom and referenced by an
 * `imeta` tag on the rumor.
 *
 * The §4 size ceiling (NIP-44 caps plaintext at 65535 bytes) means anything
 * beyond roughly 40 KB has to travel this way, so these are the common case
 * for real attachments rather than an edge case. Size is unknown until the
 * blob is fetched — left undefined instead of reported as zero.
 */
function hostedAttachments(tags: string[][]): Attachment[] {
  return parseImetaTags(tags).map((a) => ({
    filename: a.filename,
    contentType: a.mimeType,
    size: undefined,
    blossomUrl: a.url,
    blossomKey: a.encryptionKey,
    blossomNonce: a.decryptionNonce,
  }))
}

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
  ownPubkey: string | null = null,
): Promise<DecodeResult> {
  // No staleness bound here: unlike the bridge, a mailbox legitimately shows
  // mail from months ago, and the replay concern (re-relaying a message) does
  // not apply to rendering one. We accept mail plus the bridge's delivery
  // receipts; the receipt branch below decides what to do with those.
  const result = await unwrapAndVerify(event, signer, {
    maxAgeSeconds: Infinity,
    acceptKinds: [KIND_MAIL, KIND_DELIVERY_RECEIPT],
  })

  if (!result.ok) {
    return { failure: { reason: result.reason, routine: result.reason === 'not-for-us' } }
  }

  const { seal, rumor } = result

  // Delivery receipt: honour it ONLY when the configured bridge sealed it —
  // otherwise anyone could gift-wrap a fake "delivered" for your mail. A receipt
  // from any other key is silently ignored (routine), not surfaced as an error.
  if (rumor.kind === KIND_DELIVERY_RECEIPT) {
    if (bridgePubkey === null || seal.pubkey !== bridgePubkey) {
      return { failure: { reason: 'delivery-receipt not from configured bridge', routine: true } }
    }
    try {
      const parsed = JSON.parse(rumor.content) as DeliveryReceipt
      return { receipt: { messageId: parsed.messageId, deliveredTo: parsed.deliveredTo } }
    } catch {
      return { failure: { reason: 'malformed delivery-receipt content', routine: false } }
    }
  }

  try {
    // §4: content is a byte string. postal-mime must be handed real bytes —
    // given a string it re-encodes to UTF-8 before applying the declared
    // charset, which mojibakes every non-UTF-8 message.
    const parsed = await parseRfc2822(messageStringToBytes(rumor.content))

    const senderProof = await establishSenderProof({
      fromAddress: parsed.from?.address,
      sealPubkey: seal.pubkey,
      bridgePubkey,
      ownPubkey,
    })

    // Unverified senders are identified by their key, not by a header we
    // cannot check. Show the npub rather than raw hex, and label it with the
    // kind-0 name if the sender publishes one — self-asserted, so the npub
    // stays visible next to it rather than being replaced by it.
    const from =
      senderProof !== 'none'
      ? { name: parsed.from?.name, address: parsed.from!.address! }
      : {
          name: (await fetchProfileName(seal.pubkey)) ?? undefined,
          address: nip19.npubEncode(seal.pubkey),
        }

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
        from,
        to: (parsed.to ?? []).map(toDisplay),
        cc: ccAddresses.length ? ccAddresses : undefined,
        subject: parsed.subject ?? '(no subject)',
        body: parsed.text ?? '',
        bodyHtml: parsed.html ?? undefined,
        // Attachments are out of scope for this pass. Surface that they exist
        // rather than dropping them silently, so a user is never unaware that
        // a message carried one.
        attachments: [
          ...inlineAttachments(parsed.attachments),
          ...hostedAttachments(rumor.tags),
        ],
        timestamp: rumor.created_at,
        senderPubkey: seal.pubkey,
        senderProof,
        // Our own outgoing copies (the self-wrap that files under Sent) are
        // never "unread" — we wrote them. Marking them read at the source keeps
        // Sent from ever showing bold/unread and out of any unread count,
        // without emitting a read-state event for mail we sent ourselves.
        read: ownPubkey !== null && seal.pubkey === ownPubkey,
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
