import { describe, it, expect } from "vitest";
import { stampSpamMarker } from "./spam-marker.js";

const CRLF = (lines: string[]) => Buffer.from(lines.join("\r\n"), "latin1");

describe("stampSpamMarker", () => {
  it("strips sender-supplied spam headers and writes 'no' when the server did not mark it", () => {
    const raw = CRLF([
      "From: sender@example.com",
      "To: me@mailstr.app",
      "Subject: hello",
      "X-Spam-Flag: NO",
      "X-Spamd-Result: default: False [0.00 / 20.00]",
      "X-Bridge-Spam: yes",
      "X-Custom: keep-me",
      "",
      "body says X-Spam-Flag: YES but that is not a header",
    ]);

    const out = stampSpamMarker(raw).toString("latin1");

    expect(out).toContain("X-Custom: keep-me");
    expect(out).toContain("X-Bridge-Spam: no");
    const [headerBlock] = out.split("\r\n\r\n");
    expect(headerBlock).not.toContain("X-Spam-Flag");
    expect(headerBlock).not.toContain("X-Spamd-Result");
    // The forged bridge marker was removed; only the authoritative one remains.
    expect(headerBlock.match(/X-Bridge-Spam:/g)).toHaveLength(1);
    // The body is untouched, including a line that looks like a header.
    expect(out.endsWith("\r\n\r\nbody says X-Spam-Flag: YES but that is not a header")).toBe(
      true,
    );
  });

  it("writes 'yes' when the receiving server set X-Spam-Flag", () => {
    const raw = CRLF([
      "From: sender@example.com",
      "To: me@mailstr.app",
      "Subject: spam",
      "X-Spam-Flag: YES",
      "",
      "body",
    ]);

    const out = stampSpamMarker(raw).toString("latin1");
    expect(out).toContain("X-Bridge-Spam: yes");
    expect(out).not.toContain("X-Spam-Flag:");
  });

  it("matches the flag case-insensitively and ignores a NO", () => {
    const yes = CRLF(["From: a@b", "x-spam-flag: yes", "", "body"]);
    expect(stampSpamMarker(yes).toString("latin1")).toContain("X-Bridge-Spam: yes");

    const no = CRLF(["From: a@b", "X-Spam-Flag: NO", "", "body"]);
    expect(stampSpamMarker(no).toString("latin1")).toContain("X-Bridge-Spam: no");
  });

  it("removes folded spam headers with their continuation lines", () => {
    const raw = CRLF([
      "From: a@b",
      "X-Spamd-Result: default: False [0.00 / 20.00]",
      "  R_SPF_ALLOW(-0.20)[1.2.3.4]",
      "Subject: keep",
      "",
      "body",
    ]);

    const out = stampSpamMarker(raw).toString("latin1");
    expect(out).not.toContain("X-Spamd-Result");
    expect(out).not.toContain("R_SPF_ALLOW");
    expect(out).toContain("Subject: keep");
  });

  it("preserves LF line endings and 8-bit body bytes", () => {
    const head = Buffer.from("From: a@b\nX-Spam-Flag: YES\nSubject: keep\n\n", "latin1");
    const body = Buffer.from([0x80, 0xff, 0x0a, 0x41]);
    const out = stampSpamMarker(Buffer.concat([head, body]));

    const text = out.toString("latin1");
    expect(text).toContain("X-Bridge-Spam: yes\n");
    expect(text).not.toContain("X-Spam-Flag");
    // The body is byte-identical after the blank line.
    const blank = out.indexOf("\n\n");
    expect(blank).toBeGreaterThan(-1);
    expect(out.subarray(blank + 2)).toEqual(body);
  });

  it("returns a message with no header/body split unchanged", () => {
    const raw = Buffer.from("not a valid message", "latin1");
    expect(stampSpamMarker(raw)).toEqual(raw);
  });
});
