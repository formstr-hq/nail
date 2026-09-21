import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { bytesToMessageString } from "./protocol/bytes.js";

/**
 * Fallback for inbound mail that relays will not carry.
 *
 * A message with real attachments routinely exceeds NIP-44's 65535-byte
 * plaintext ceiling (§4), and relays reject oversized events outright.
 * Re-publishing the same bytes can never succeed, so when the first publish
 * fails the listener rebuilds the message with every attachment replaced by
 * a short `attachments_error.txt` notice and publishes that instead.
 * Blossom offload (which would keep the attachment) is a separate feature;
 * this only guarantees the mail arrives at all.
 *
 * Rebuilding via MailComposer is best-effort, not byte-identical: headers
 * that matter for identity and threading (`Message-ID`, `Date`, `References`,
 * `In-Reply-To`, `From`/`To`/`Cc`, `Subject`) are preserved explicitly, exact
 * MIME framing is not. That is acceptable only because it is the sole way to
 * get an otherwise permanently-bouncing message under the ceiling.
 *
 * PGP/MIME is deliberately excluded: its `application/octet-stream` part is
 * not an attachment but the entire encrypted message (text and real
 * attachments packed inside the ciphertext), so stripping it would leave an
 * empty shell. `stripAttachments` returns null for that shape and the
 * message keeps bouncing until the offload feature lands.
 */

export const ATTACHMENT_DROP_FILENAME = "attachments_error.txt";

export const ATTACHMENT_DROP_NOTICE =
  "This mail contained attachments which could not be delivered. Attachments are still a work in progress.";

const ARMOR_MARKER = "-----BEGIN PGP MESSAGE-----";

function addressText(
  value: AddressObject | AddressObject[] | undefined,
): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.map((v) => v.text).join(", ") : value.text;
}

/** The RFC 3156 shape — see the module doc for why it must never be stripped. */
function isPgpMime(parsed: ParsedMail): boolean {
  if (parsed.text?.includes(ARMOR_MARKER)) return true;
  return parsed.attachments.some(
    (a) =>
      a.contentType.startsWith("application/pgp-encrypted") ||
      (a.contentType === "application/octet-stream" &&
        a.content.toString("utf8").includes(ARMOR_MARKER)),
  );
}

/**
 * Rebuild `raw` with its attachments replaced by a single
 * `attachments_error.txt` carrying the notice. Returns null when there is
 * nothing to strip (no attachments) or when stripping would corrupt the
 * message (PGP/MIME) — callers treat null as "no retry available".
 *
 * The return is the byte-string representation (§4), the same convention the
 * rest of the pipeline uses for `rumor.content`.
 */
export async function stripAttachments(raw: Buffer): Promise<string | null> {
  const parsed = await simpleParser(raw);
  if (parsed.attachments.length === 0) return null;
  if (isPgpMime(parsed)) return null;

  const composer = new MailComposer({
    from: parsed.from?.text,
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    replyTo: addressText(parsed.replyTo),
    subject: parsed.subject,
    // The notice is the body too when the original was attachment-only,
    // otherwise the rebuilt message would carry no human-readable body at all.
    text: parsed.text ?? (parsed.html ? undefined : ATTACHMENT_DROP_NOTICE),
    html: parsed.html || undefined,
    attachments: [
      {
        filename: ATTACHMENT_DROP_FILENAME,
        content: Buffer.from(`${ATTACHMENT_DROP_NOTICE}\n`, "utf8"),
        contentType: "text/plain",
      },
    ],
    messageId: parsed.messageId,
    date: parsed.date,
    references: parsed.references,
    inReplyTo: parsed.inReplyTo,
  });

  const rebuilt = await composer.compile().build();
  return bytesToMessageString(new Uint8Array(rebuilt));
}
