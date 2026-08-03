import { describe, it, expect } from "vitest";
import { parseImetaTags } from "@nostr-bridge/protocol/attachments.js";

describe("parseImetaTags", () => {
  it("parses a well-formed encrypted imeta tag", () => {
    const tags = [
      [
        "imeta",
        "url https://blossom.example/abc123",
        "filename report.pdf",
        "m application/pdf",
        "x abc123sha256",
        "size 4096",
        "decryption-key deadbeef",
        "decryption-nonce cafebabe",
        "encryption-algorithm aes-256-gcm",
      ],
    ];
    const result = parseImetaTags(tags);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      url: "https://blossom.example/abc123",
      filename: "report.pdf",
      mimeType: "application/pdf",
      encryptionKey: "deadbeef",
      decryptionNonce: "cafebabe",
    });
  });

  it("parses an unencrypted imeta tag (no decryption fields)", () => {
    const tags = [["imeta", "url https://cdn.example/photo.jpg", "filename photo.jpg", "m image/jpeg"]];
    const [result] = parseImetaTags(tags);
    expect(result.encryptionKey).toBeUndefined();
    expect(result.decryptionNonce).toBeUndefined();
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("ignores non-imeta tags", () => {
    const tags = [
      ["p", "somepubkey"],
      ["e", "someeventid"],
      ["imeta", "url https://blossom.example/x", "filename x.bin"],
    ];
    expect(parseImetaTags(tags)).toHaveLength(1);
  });

  it("skips imeta tags that have no url field", () => {
    const tags = [["imeta", "filename orphan.pdf", "m application/pdf"]];
    expect(parseImetaTags(tags)).toHaveLength(0);
  });

  it("applies defaults for missing filename and mime type", () => {
    const tags = [["imeta", "url https://blossom.example/blob"]];
    const [result] = parseImetaTags(tags);
    expect(result.filename).toBe("attachment");
    expect(result.mimeType).toBe("application/octet-stream");
  });

  it("parses multiple imeta tags independently", () => {
    const tags = [
      ["imeta", "url https://blossom.example/a", "filename a.txt", "m text/plain"],
      ["imeta", "url https://blossom.example/b", "filename b.png", "m image/png"],
    ];
    const result = parseImetaTags(tags);
    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe("a.txt");
    expect(result[1].filename).toBe("b.png");
  });

  it("handles imeta entries without a space separator gracefully", () => {
    const tags = [["imeta", "url https://blossom.example/x", "malformed-no-space"]];
    const result = parseImetaTags(tags);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://blossom.example/x");
  });

  it("returns an empty array when given no tags", () => {
    expect(parseImetaTags([])).toEqual([]);
  });
});
