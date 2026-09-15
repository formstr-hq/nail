import type { Event } from 'nostr-tools'
import {
  unwrapAndVerify,
  messageStringToBytes,
  parseImetaTags,
  type ProtocolSigner,
} from '@protocol'
import { parseRfc2822 } from './rfc2822'
import type { Attachment, Email } from '@/app/types/mail'

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
  /**
   * True when the failure was transient (the signer timed out / was
   * unreachable), so the same wrap may decode on a retry. Distinct from
   * routine: routine is "not ours, never will be", this is "ours, try again".
   */
  retryable?: boolean
}

export type DecodeResult =
  | {
      email: Email
      /**
       * The wrap author's ephemeral key, when the sender embedded it
       * (WRAP_KEY_TAG). Caller persists it (store.saveWrapKey) so a later
       * "delete forever" can author a NIP-09 kind-5 the relays will honor.
       */
      wrapSecret?: string
    }
  | { failure: DecodeFailure }

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
 * Pull an RFC 3156 PGP/MIME body out of the parsed attachment list.
 *
 * `multipart/encrypted` splits an encrypted message into two sibling parts: a
 * fixed `application/pgp-encrypted` control part (just the literal
 * "Version: 1") and an `application/octet-stream` data part holding the
 * actual armored ciphertext. postal-mime does not understand this structure —
 * it has no `text`/`html` for a message shaped this way, and simply hands
 * both parts back as opaque attachments. Detect that pairing here and lift the
 * armor out so it can flow through the same `email.body` path inline-PGP mail
 * already uses, rather than teaching every PGP consumer a second code path.
 *
 * Returns the data part alongside the armor text so the caller can exclude
 * exactly that part (by reference) from the attachment list — other
 * octet-stream attachments a message happens to carry must not be swallowed.
 */
function extractPgpMime(
  attachments: ParsedAttachment[] | undefined,
): { armored: string; dataPart: ParsedAttachment } | null {
  const atts = attachments ?? []
  if (!atts.some((a) => a.mimeType === 'application/pgp-encrypted')) return null

  for (const a of atts) {
    if (a.mimeType !== 'application/octet-stream') continue
    const bytes =
      typeof a.content === 'string'
        ? new TextEncoder().encode(a.content)
        : new Uint8Array(a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content))
    const text = new TextDecoder().decode(bytes)
    if (text.includes('-----BEGIN PGP MESSAGE-----')) return { armored: text, dataPart: a }
  }
  return null
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
 * The wrap is verified here, but the *interpretation* of its RFC 2822 headers
 * is deliberately not: `From:` is text the sender chose, and whether it may be
 * shown depends on the configured bridges, which resolve asynchronously and
 * can change (or fail) at any time. So the email stores the raw header and the
 * sealing key, and the proof is derived at render time — see
 * lib/mail/senderProof.ts. Computing it here would freeze a verdict on
 * whatever was known at decode time and never correct it.
 */
export async function decodeGiftWrap(
  event: Event,
  signer: ProtocolSigner,
  ownPubkey: string | null = null,
): Promise<DecodeResult> {
  // No staleness bound here: unlike the bridge, a mailbox legitimately shows
  // mail from months ago, and the replay concern (re-relaying a message) does
  // not apply to rendering one.
  const result = await unwrapAndVerify(event, signer, { maxAgeSeconds: Infinity })

  if (!result.ok) {
    return {
      failure: {
        reason: result.reason,
        routine: result.reason === 'not-for-us',
        retryable: result.reason === 'signer-error',
      },
    }
  }

  const { seal, rumor, wrapSecret } = result

  try {
    // §4: content is a byte string. postal-mime must be handed real bytes —
    // given a string it re-encodes to UTF-8 before applying the declared
    // charset, which mojibakes every non-UTF-8 message.
    const rawBytes = messageStringToBytes(rumor.content)
    const parsed = await parseRfc2822(rawBytes)

    // A gift wrap the sender never framed as RFC 2822 — a bare NIP-17-style note
    // carried on the mail kind, say — parses to almost nothing: postal-mime
    // reads its first line as a header and drops the rest, so `text`/`html` come
    // back empty and the message opens blank. When none of the RFC 2822 shape is
    // present (no subject, no addresses, no html) it was not really a MIME
    // message, so show the whole decoded content as the body rather than losing
    // it. Real mail — anything the composer or the bridge produces — always
    // carries a From/To/Subject, so it never takes this path.
    const looksLikeMail = Boolean(
      parsed.subject || parsed.from?.address || parsed.to?.length || parsed.html,
    )
    const rawBody = new TextDecoder().decode(rawBytes)

    // RFC 3156 PGP/MIME: the ciphertext lives in a data attachment, not
    // `parsed.text`. When present, treat its armor as the body — same as an
    // inline-PGP message — instead of showing a blank email with two mystery
    // attachments.
    const pgpMime = looksLikeMail ? extractPgpMime(parsed.attachments) : null

    // The claimed `From:` header, kept verbatim. Never display it directly —
    // use useSenderIdentity / deriveSenderIdentity, which decide whether it is
    // backed by the sealing key. A header-less message gets an empty address;
    // the derivation handles that as "no claim".
    const fromHeader = {
      name: parsed.from?.name,
      address: parsed.from?.address || parsed.from?.name || '',
    }

    const toDisplay = (a: { name?: string; address?: string }) => ({
      name: a.address ? a.name : undefined,
      address: a.address || a.name || '',
    })

    const ccAddresses = (parsed.cc ?? []).map(toDisplay)

    return {
      wrapSecret,
      email: {
        id: event.id,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references?.split(/\s+/).filter(Boolean),
        fromHeader,
        to: (parsed.to ?? []).map(toDisplay),
        cc: ccAddresses.length ? ccAddresses : undefined,
        subject: parsed.subject ?? '(no subject)',
        body: pgpMime ? pgpMime.armored : looksLikeMail ? (parsed.text ?? '') : rawBody,
        bodyHtml: looksLikeMail ? (parsed.html ?? undefined) : undefined,
        // Attachments are out of scope for this pass. Surface that they exist
        // rather than dropping them silently, so a user is never unaware that
        // a message carried one. The PGP/MIME control+data parts are the
        // message body, not attachments, so they are excluded here once lifted
        // into `body` above.
        attachments: [
          ...inlineAttachments(
            pgpMime
              ? (parsed.attachments ?? []).filter(
                  (a) => a !== pgpMime.dataPart && a.mimeType !== 'application/pgp-encrypted',
                )
              : parsed.attachments,
          ),
          ...hostedAttachments(rumor.tags),
        ],
        timestamp: rumor.created_at,
        senderPubkey: seal.pubkey,
        // Our own outgoing copies (the self-wrap that files under Sent) are
        // never "unread" — we wrote them. Marking them read at the source keeps
        // Sent from ever showing bold/unread and out of any unread count,
        // without emitting a read-state event for mail we sent ourselves.
        read: ownPubkey !== null && seal.pubkey === ownPubkey,
        labelEventIds: [],
        labels: [],
        // Ground truth for the reader's debug disclosure — what actually
        // arrived, before any RFC 2822 interpretation.
        debug: {
          sealPubkey: seal.pubkey,
          rumor: {
            id: rumor.id,
            kind: rumor.kind,
            pubkey: rumor.pubkey,
            created_at: rumor.created_at,
            tags: rumor.tags,
            content: rumor.content,
          },
        },
      },
    }
  } catch (err) {
    return {
      failure: { reason: `rfc2822 parse failed: ${(err as Error).message}`, routine: false },
    }
  }
}
