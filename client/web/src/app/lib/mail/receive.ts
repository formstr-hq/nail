import type { Event } from 'nostr-tools'
import {
  unwrapAndVerify,
  messageStringToBytes,
  parseImetaTags,
  readChunkMeta,
  type ProtocolSigner,
  type Rumor,
  type UnwrapResult,
} from '@protocol'
import type { ChunkAssembler, WrapSecret } from './chunkAssembler'
import { parseRfc2822 } from './rfc2822'
import {
  parseAttachmentLinks,
  stripAttachmentLinksHtml,
} from './attachmentLinks'
import { splitMimeAttachments, type ParsedMimeAttachment } from './mimeAttachments'
import { spamFromHeaders } from './folders'
import type { Attachment, Email } from '@/app/types/mail'

/** The shape postal-mime hands back; imported structurally to avoid a dep. */
type ParsedAttachment = ParsedMimeAttachment

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
    size: a.size,
    blossomUrl: a.url,
    blossomKey: a.encryptionKey,
    blossomNonce: a.decryptionNonce,
    blossomBlobHash: a.blobHash,
    blossomFileHash: a.unencryptedFileHash,
  }))
}

/**
 * The same share link can arrive in the body and in `Attachments.txt`. Keep
 * one chip per URL; inline files have no URL and are never deduped by name.
 */
function dedupeLinkedAttachments(attachments: Attachment[]): Attachment[] {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const key = attachment.shareUrl ?? attachment.blossomUrl
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
  const result = await unwrapGiftWrap(event, signer)
  if (!result.ok) return { failure: failureFor(result.reason) }

  const decoded = await decodeRumor(result.rumor, result.seal, ownPubkey, {
    id: event.id,
  })
  if ('failure' in decoded) return decoded
  return result.wrapSecret ? { ...decoded, wrapSecret: result.wrapSecret } : decoded
}

/** Decode an already-unwrapped rumor (a full RFC 2822 message). */
export type RumorDecodeResult = { email: Email } | { failure: DecodeFailure }

/**
 * Unwrap and verify one gift wrap.
 *
 * Split out from the RFC 2822 work because a chunked message's rumor carries a
 * byte range, not a message: the inbox must inspect the tags and buffer the
 * part before anything is parsed.
 */
export async function unwrapGiftWrap(
  event: Event,
  signer: ProtocolSigner,
): Promise<UnwrapResult> {
  // No staleness bound here: unlike the bridge, a mailbox legitimately shows
  // mail from months ago, and the replay concern (re-relaying a message) does
  // not apply to rendering one.
  return unwrapAndVerify(event, signer, { maxAgeSeconds: Infinity })
}

function failureFor(reason: string): DecodeFailure {
  return {
    reason,
    routine: reason === 'not-for-us',
    retryable: reason === 'signer-error',
  }
}

/** Outcome of the inbox decode step, which may buffer a chunk instead. */
export type InboxDecodeOutcome =
  | { email: Email; wrapSecrets: WrapSecret[] }
  | { buffered: { have: number; total: number } }
  /** A part already assembled and delivered (relay replay). */
  | { ignored: true }
  | { failure: DecodeFailure }

/**
 * Inbox entry point: decode a wrap, or buffer its chunk.
 *
 * A chunk's content is a byte range, so it must be intercepted here rather
 * than handed to `decodeRumor`/`parseRfc2822`. Only the completed message is
 * parsed, with chunk 0's wrap id as the email id and every part listed in
 * `wrapIds` for delete-forever.
 */
export async function decodeOrAssemble(
  event: Event,
  signer: ProtocolSigner,
  ownPubkey: string | null,
  assembler: ChunkAssembler,
): Promise<InboxDecodeOutcome> {
  const result = await unwrapGiftWrap(event, signer)
  if (!result.ok) return { failure: failureFor(result.reason) }

  const { rumor, seal, wrapSecret } = result
  const wrapSecrets: WrapSecret[] = wrapSecret
    ? [{ id: event.id, secret: wrapSecret }]
    : []

  if (!readChunkMeta(rumor.tags)) {
    const decoded = await decodeRumor(rumor, seal, ownPubkey, { id: event.id })
    return 'failure' in decoded ? decoded : { email: decoded.email, wrapSecrets }
  }

  const added = await assembler.add({
    tags: rumor.tags,
    content: rumor.content,
    wrapId: event.id,
    wrapSecret,
  })

  if (added.status === 'buffered') {
    return { buffered: { have: added.have, total: added.total } }
  }
  if (added.status === 'partial') {
    if (added.headerless) {
      // Chunk 0 is still missing, but the body fragments are useful. Show a
      // headerless placeholder; it will be replaced when chunk 0 arrives.
      return {
        email: partialFallbackEmail(
          { ...rumor, content: added.raw },
          seal,
          {
            id: added.id,
            wrapIds: added.wrapIds,
            partial: {
              have: added.have,
              total: added.total,
              missing: added.missing,
              headerless: true,
            },
          },
        ),
        wrapSecrets: added.wrapSecrets,
      }
    }
    // Chunk 0 is present, so the contiguous prefix is a real (if truncated)
    // RFC 2822 message. Render it now and let later parts replace it.
    const decoded = await decodeRumor(
      { ...rumor, content: added.raw },
      seal,
      ownPubkey,
      {
        id: added.id,
        wrapIds: added.wrapIds,
        partial: { have: added.have, total: added.total, missing: added.missing },
      },
    )
    return 'failure' in decoded
      ? { buffered: { have: added.have, total: added.total } }
      : {
          email: { ...decoded.email, pendingId: `pending:${added.msgid}` },
          wrapSecrets: added.wrapSecrets,
        }
  }
  if (added.status === 'duplicate') return { ignored: true }
  if (added.status === 'invalid') {
    return { failure: { reason: `chunk: ${added.reason}`, routine: false } }
  }

  const decoded = await decodeRumor(
    { ...rumor, content: added.message.raw },
    seal,
    ownPubkey,
    { id: added.message.id, wrapIds: added.message.wrapIds },
  )
  return 'failure' in decoded
    ? decoded
    : {
        email: { ...decoded.email, pendingId: `pending:${added.message.msgid}` },
        wrapSecrets: added.message.wrapSecrets,
      }
}

/**
 * A renderable fallback when the contiguous prefix is too truncated for the
 * MIME parser. It still shows the received bytes and the progress, rather than
 * making a large message invisible until the last chunk arrives.
 */
function partialFallbackEmail(
  rumor: Rumor,
  seal: Event,
  opts: {
    id: string
    wrapIds?: string[]
    partial?: {
      have: number
      total: number
      missing: number[]
      headerless?: boolean
    }
  },
): Email {
  const rawBody = new TextDecoder().decode(messageStringToBytes(rumor.content))
  return {
    id: opts.id,
    ...(opts.wrapIds ? { wrapIds: opts.wrapIds } : {}),
    fromHeader: { address: '' },
    to: [],
    subject: '(receiving message…)',
    body: rawBody,
    attachments: [],
    timestamp: rumor.created_at,
    senderPubkey: seal.pubkey,
    read: false,
    labelEventIds: [],
    labels: [],
    ...(opts.partial ? { partial: opts.partial } : {}),
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
  }
}

/**
 * Turn a verified rumor into a displayable email.
 *
 * `opts.id` is the wrap event id that becomes `Email.id`; for a chunked
 * message it is chunk 0's wrap id and `wrapIds` lists the rest, so the
 * existing wrap-keyed state (delete, read flags) keeps working while delete
 * can reach every part.
 */
export async function decodeRumor(
  rumor: Rumor,
  seal: Event,
  ownPubkey: string | null,
  opts: {
    id: string
    wrapIds?: string[]
    /** Present while a chunked message is still arriving. */
    partial?: {
      have: number
      total: number
      missing: number[]
      headerless?: boolean
    }
  },
): Promise<RumorDecodeResult> {
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

    // SMTP-bound messages carry drive share links in the body because the
    // bridge cannot read the rumor's `imeta` tags. Pull that list out and turn
    // it into ordinary attachments, so our reader sees chips, not raw URLs.
    // A PGP/MIME body is ciphertext — its links live inside the armor and are
    // parsed after decryption.
    const bodyText = pgpMime ? pgpMime.armored : looksLikeMail ? (parsed.text ?? '') : rawBody
    const linked = pgpMime ? { body: bodyText, attachments: [] } : parseAttachmentLinks(bodyText)
    const bodyHtml =
      looksLikeMail && linked.attachments.length > 0
        ? stripAttachmentLinksHtml(parsed.html ?? undefined)
        : looksLikeMail
          ? (parsed.html ?? undefined)
          : undefined

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

    const { inline, shared } = splitMimeAttachments(
      pgpMime
        ? (parsed.attachments ?? []).filter(
            (a) => a !== pgpMime.dataPart && a.mimeType !== 'application/pgp-encrypted',
          )
        : parsed.attachments,
    )

    return {
      email: {
        id: opts.id,
        ...(opts.wrapIds ? { wrapIds: opts.wrapIds } : {}),
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references?.split(/\s+/).filter(Boolean),
        fromHeader,
        to: (parsed.to ?? []).map(toDisplay),
        cc: ccAddresses.length ? ccAddresses : undefined,
        subject: parsed.subject ?? '(no subject)',
        body: linked.body,
        bodyHtml,
        // Inline MIME parts, legacy `imeta` attachments, drive links parsed
        // from the body, and the real `attachments.txt` part. The PGP/MIME
        // control+data parts are the message body, not attachments, so they
        // are excluded here once lifted into `body` above.
        attachments: opts.partial
          ? []
          : dedupeLinkedAttachments([
              ...inline,
              ...hostedAttachments(rumor.tags),
              ...linked.attachments,
              ...shared,
            ]),
        timestamp: rumor.created_at,
        senderPubkey: seal.pubkey,
        // Our own outgoing copies (the self-wrap that files under Sent) are
        // never "unread" — we wrote them. Marking them read at the source keeps
        // Sent from ever showing bold/unread and out of any unread count,
        // without emitting a read-state event for mail we sent ourselves.
        read: ownPubkey !== null && seal.pubkey === ownPubkey,
        labelEventIds: [],
        labels: [],
        ...(opts.partial ? { partial: opts.partial } : {}),
        // Derived from the receiving server's marker, never stored: a folder
        // `match: { spam: true }` files it (see lib/mail/folders.ts), and an
        // explicit folder overrides that match ("Not spam").
        spam: spamFromHeaders(parsed.headers),
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
    if (opts.partial) {
      // A truncated prefix can fail MIME parsing. Show the bytes we have
      // instead of making the whole message invisible.
      return { email: partialFallbackEmail(rumor, seal, opts) }
    }
    return {
      failure: { reason: `rfc2822 parse failed: ${(err as Error).message}`, routine: false },
    }
  }
}
