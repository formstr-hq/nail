import type { Event } from 'nostr-tools'
import { unwrapAndVerify, messageStringToBytes, type ProtocolSigner } from '@protocol'
import { nip19 } from 'nostr-tools'
import { probeNip05 } from '@/lib/nostr/nip05'
import { fetchProfileName } from '@/lib/nostr/profile'
import { parseRfc2822 } from './rfc2822'
import type { Email } from '@/types/mail'

export interface DecodeFailure {
  reason: string
  /** True when this is routine — a wrap that simply is not ours to read. */
  routine: boolean
}

export type DecodeResult = { email: Email } | { failure: DecodeFailure }

/**
 * May we display the RFC 2822 `From:` header as the sender?
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
 */
async function fromHeaderIsTrustworthy(params: {
  fromAddress: string | undefined
  sealPubkey: string
  bridgePubkey: string | null
  ownPubkey: string | null
}): Promise<boolean> {
  const { fromAddress, sealPubkey, bridgePubkey, ownPubkey } = params
  if (!fromAddress) return false
  if (bridgePubkey !== null && sealPubkey === bridgePubkey) return true
  if (ownPubkey !== null && sealPubkey === ownPubkey) return true

  // Cached and bounded; a miss or a timeout just means we show the pubkey.
  return (await probeNip05(fromAddress)) === sealPubkey
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

    const trustFrom = await fromHeaderIsTrustworthy({
      fromAddress: parsed.from?.address,
      sealPubkey: seal.pubkey,
      bridgePubkey,
      ownPubkey,
    })

    // Unverified senders are identified by their key, not by a header we
    // cannot check. Show the npub rather than raw hex, and label it with the
    // kind-0 name if the sender publishes one — self-asserted, so the npub
    // stays visible next to it rather than being replaced by it.
    const from = trustFrom
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
