import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import {
  stripAttachments,
  ATTACHMENT_DROP_FILENAME,
  ATTACHMENT_DROP_NOTICE,
} from "./stripAttachments.js";
import { messageStringToBytes } from "./protocol/bytes.js";

async function buildRaw(opts: {
  text?: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}): Promise<Buffer> {
  const composer = new MailComposer({
    from: "Alice <alice@example.org>",
    to: "bob@mailstr.app",
    cc: "carol@example.org",
    subject: "report attached",
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments,
    messageId: "<fixed-id@example.org>",
    date: new Date("2026-01-01T00:00:00Z"),
  });
  return composer.compile().build();
}

async function parseBack(raw: string) {
  return simpleParser(Buffer.from(messageStringToBytes(raw)));
}

function addressText(value: { text: string } | { text: string }[] | undefined): string {
  return Array.isArray(value) ? value.map((v) => v.text).join(", ") : (value?.text ?? "");
}

describe("stripAttachments", () => {
  it("replaces attachments with the attachments_error.txt notice", async () => {
    const original = await buildRaw({
      text: "see attached",
      attachments: [
        { filename: "big.bin", content: Buffer.alloc(200_000, 7) },
        { filename: "small.txt", content: Buffer.from("hi"), contentType: "text/plain" },
      ],
    });

    const stripped = await stripAttachments(original);
    expect(stripped).not.toBeNull();

    const parsed = await parseBack(stripped!);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe(ATTACHMENT_DROP_FILENAME);
    expect(parsed.attachments[0].content.toString("utf8")).toContain(ATTACHMENT_DROP_NOTICE);
    expect(parsed.text).toContain("see attached");
  });

  it("preserves the headers identity and threading depend on", async () => {
    const original = await buildRaw({
      text: "body",
      attachments: [{ filename: "a.bin", content: Buffer.alloc(100, 1) }],
    });

    const stripped = await stripAttachments(original);
    const parsed = await parseBack(stripped!);

    expect(parsed.messageId).toBe("<fixed-id@example.org>");
    expect(parsed.subject).toBe("report attached");
    expect(addressText(parsed.from)).toContain("alice@example.org");
    expect(addressText(parsed.to)).toContain("bob@mailstr.app");
    expect(addressText(parsed.cc)).toContain("carol@example.org");
  });

  it("keeps the HTML body when there is no text alternative", async () => {
    const original = await buildRaw({
      html: "<p>rich body</p>",
      attachments: [{ filename: "a.bin", content: Buffer.alloc(100, 1) }],
    });

    const stripped = await stripAttachments(original);
    const parsed = await parseBack(stripped!);
    expect(parsed.html).toContain("rich body");
  });

  it("uses the notice as the body when the mail was attachment-only", async () => {
    const original = await buildRaw({
      attachments: [{ filename: "a.bin", content: Buffer.alloc(100, 1) }],
    });

    const stripped = await stripAttachments(original);
    const parsed = await parseBack(stripped!);
    expect(parsed.text).toContain(ATTACHMENT_DROP_NOTICE);
  });

  it("returns null when there is nothing to strip", async () => {
    const original = await buildRaw({ text: "plain mail" });
    expect(await stripAttachments(original)).toBeNull();
  });

  it("does not mojibake a non-UTF-8 body when rebuilding", async () => {
    // A latin-1 body must survive the parse/rebuild round trip; if it did not,
    // stripping would silently corrupt every non-UTF-8 message it touches
    // (the §4 byte-string rule exists precisely because this is lossy).
    const boundary = "mix-boundary";
    const bytes = Buffer.from(
      [
        "From: alice@example.org",
        "To: bob@mailstr.app",
        "Subject: latin1",
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=iso-8859-1",
        "Content-Transfer-Encoding: 8bit",
        "",
        "caf\xe9",
        `--${boundary}`,
        "Content-Type: application/octet-stream",
        "Content-Transfer-Encoding: base64",
        "Content-Disposition: attachment; filename=\"a.bin\"",
        "",
        Buffer.alloc(500, 2).toString("base64"),
        `--${boundary}--`,
        "",
      ].join("\r\n"),
      "latin1",
    );

    const stripped = await stripAttachments(bytes);
    expect(stripped).not.toBeNull();

    // The character must survive the parse/rebuild: mailparser decodes the
    // declared iso-8859-1, MailComposer re-encodes (as UTF-8) and re-declares
    // it, so the text reads "café" on the far side — never a U+FFFD from a
    // lossy byte-string-to-UTF-8 decode.
    const parsed = await parseBack(stripped!);
    expect(parsed.text).toContain("café");
    expect(parsed.text).not.toContain("\uFFFD");
  });

  it("refuses to strip an RFC 3156 PGP/MIME message", async () => {
    const boundary = "pgp-boundary";
    const armor = "-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----";
    const raw = Buffer.from(
      [
        "From: alice@example.org",
        "To: bob@mailstr.app",
        "Subject: encrypted",
        `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: application/pgp-encrypted",
        "",
        "Version: 1",
        `--${boundary}`,
        "Content-Type: application/octet-stream",
        "",
        armor,
        `--${boundary}--`,
        "",
      ].join("\r\n"),
      "utf8",
    );

    expect(await stripAttachments(raw)).toBeNull();
  });

  it("turns an oversized attachment mail into something that fits the NIP-44 ceiling", async () => {
    const original = await buildRaw({
      text: "see attached",
      attachments: [{ filename: "photo.jpg", content: Buffer.alloc(300_000, 9) }],
    });
    expect(original.byteLength).toBeGreaterThan(65535);

    const stripped = await stripAttachments(original);
    expect(stripped).not.toBeNull();
    expect(stripped!.length).toBeLessThan(65535);
  });
});
