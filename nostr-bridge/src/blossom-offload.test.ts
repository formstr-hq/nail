import { describe, it, expect, vi } from "vitest";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";

// config.ts validates these at module load; this test imports through it.
vi.hoisted(() => {
  process.env.LOCAL_DOMAINS = "mailstr.app";
  process.env.NOSTR_BRIDGE_NSEC = "11".repeat(32);
  process.env.BLOSSOM_SERVER_URL = "https://env.example";
});

vi.mock("./blossom-client.js", () => ({ uploadEncryptedAttachment: vi.fn() }));
import type { Attachment } from "mailparser";
import {
  blossomCandidates,
  imetaTags,
  offloadAttachments,
} from "./blossom-offload.js";
import { uploadEncryptedAttachment } from "./blossom-client.js";

const mockedUpload = vi.mocked(uploadEncryptedAttachment);

function attachment(over: Partial<Attachment> = {}): Attachment {
  return {
    filename: "report.pdf",
    contentType: "application/pdf",
    size: 1234,
    content: Buffer.alloc(0),
    contentDisposition: "attachment",
    ...over,
  } as Attachment;
}

const uploaded = {
  url: "https://blossom.example/abc",
  sha256: "f".repeat(64),
  encryptionKey: "a".repeat(64),
  decryptionNonce: "b".repeat(24),
};

describe("blossomCandidates", () => {
  const env = "https://nos.example";

  it("uses the operator server when the user has none", () => {
    expect(blossomCandidates([], env)).toEqual([env]);
  });

  it("tries the user's servers first, then the operator server", () => {
    expect(blossomCandidates(["https://one.example/", "https://two.example"], env)).toEqual([
      "https://one.example",
      "https://two.example",
      env,
    ]);
  });

  it("de-duplicates and drops invalid URLs", () => {
    expect(
      blossomCandidates(["https://nos.example", "wss://not-http", "https://nos.example"], env),
    ).toEqual([env]);
  });
});

describe("imetaTags", () => {
  it("writes the fields the client's parseImetaTags/AttachmentRow read", () => {
    expect(imetaTags(attachment(), uploaded)).toEqual([
      "imeta",
      "url https://blossom.example/abc",
      "m application/pdf",
      "filename report.pdf",
      "size 1234",
      `decryption-key ${uploaded.encryptionKey}`,
      `decryption-nonce ${uploaded.decryptionNonce}`,
      `x ${uploaded.sha256}`,
    ]);
  });

  it("defaults a missing filename and content type", () => {
    const tags = imetaTags(
      attachment({ filename: undefined, contentType: "application/octet-stream" }),
      uploaded,
    );
    expect(tags).toContain("filename attachment");
    expect(tags).toContain("m application/octet-stream");
  });
});

describe("offloadAttachments", () => {
  it("does not touch a message that already fits one wrap", async () => {
    expect(
      await offloadAttachments(Buffer.from("small"), {
        recipientPubkey: "a".repeat(64),
        relays: [],
        recipient: "b@example.com",
      }),
    ).toBeNull();
  });

  it("falls back to the operator's server when the user's server fails", async () => {
    mockedUpload.mockImplementation(async (_bytes, _key, server) => {
      if (server.startsWith("https://user.example")) throw new Error("nope");
      return {
        url: "https://env.example/abc",
        sha256: "f".repeat(64),
        encryptionKey: "a".repeat(64),
        decryptionNonce: "b".repeat(24),
      };
    });

    const composer = new MailComposer({
      from: "a@example.com",
      to: "b@example.com",
      subject: "attachment",
      text: "body",
      attachments: [{ filename: "a.pdf", content: Buffer.alloc(90_000, 1) }],
    });
    const raw = await composer.compile().build();

    const result = await offloadAttachments(raw, {
      recipientPubkey: "a".repeat(64),
      relays: [],
      recipient: "b@example.com",
      userServers: ["https://user.example"],
    });

    expect(mockedUpload).toHaveBeenNthCalledWith(
      1,
      expect.any(Buffer),
      expect.any(Uint8Array),
      "https://user.example",
      expect.any(Number),
    );
    expect(mockedUpload).toHaveBeenNthCalledWith(
      2,
      expect.any(Buffer),
      expect.any(Uint8Array),
      "https://env.example",
      expect.any(Number),
    );
    expect(result).not.toBeNull();
    expect(result!.tags.some((t) => t[0] === "imeta")).toBe(true);
    const parsed = await simpleParser(Buffer.from(result!.raw, "latin1"));
    expect(parsed.attachments).toHaveLength(0);
  });

  it("returns null for an over-ceiling message with no attachments", async () => {
    const raw = Buffer.from(`Subject: big\r\n\r\n${"x".repeat(100_000)}`, "latin1");
    expect(
      await offloadAttachments(raw, {
        recipientPubkey: "a".repeat(64),
        relays: [],
        recipient: "b@example.com",
      }),
    ).toBeNull();
  });
});
