import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";

// config.ts throws at module load if LOCAL_DOMAINS is unset, and parses
// NOSTR_BRIDGE_NSEC into a real secp256k1 key eagerly (getPublicKey at
// module scope). Both must be set before lmtp-server.ts (which imports
// config.ts) is evaluated, so this runs via vi.hoisted — the one block in
// this file that Vitest hoists above every import, including `import { vi }`
// itself.
vi.hoisted(() => {
  process.env.LOCAL_DOMAINS = "mailstr.app";
  // 32 bytes of 0x11 — well under curve order, nonzero, valid hex privkey.
  process.env.NOSTR_BRIDGE_NSEC = "11".repeat(32);
  // These tests exercise the wrap-ceiling logic, not the transport buffer
  // cap (covered separately in lmtp-server.size.test.ts), so keep the buffer
  // cap out of the way.
  process.env.MAIL_MAX_BYTES = String(64 * 1024 * 1024);
});

// handleMessage is unit-tested against stubbed dependencies, not the network:
// mocking the two modules it calls out to (nip05 lookup, nostr publish) is a
// smaller change to production code than threading them through as explicit
// parameters (dependency injection) would require, since both are already
// plain named exports called directly. UserResolver, by contrast, was already
// passed in as a parameter, so it's stubbed via vi.spyOn on a real instance
// instead of a third vi.mock.
vi.mock("./nip05.js", () => ({ lookupNip05: vi.fn() }));
vi.mock("./nostr-publisher.js", () => ({ publishMail: vi.fn() }));

import { handleMessage, LmtpError } from "./lmtp-server.js";
import { lookupNip05, type Nip05Result } from "./nip05.js";
import { publishMail } from "./nostr-publisher.js";
import { UserResolver } from "./user-resolver.js";

const mockedLookup = vi.mocked(lookupNip05);
const mockedPublish = vi.mocked(publishMail);

const PUBKEY = "a".repeat(64);
const RAW = Buffer.from(
  ["From: bob@example.com", "To: alice@mailstr.app", "Subject: hi", "", "hello"].join("\r\n"),
  "utf8",
);

function buildRawWithAttachment(
  attachmentBytes = 1000,
  text = "see attached",
): Promise<Buffer> {
  const composer = new MailComposer({
    from: "bob@example.com",
    to: "alice@mailstr.app",
    subject: "with attachment",
    text,
    attachments: [{ filename: "file.bin", content: Buffer.alloc(attachmentBytes, 1) }],
    messageId: "<attached@example.com>",
    date: new Date("2026-01-01T00:00:00Z"),
  });
  return composer.compile().build();
}

function foundResult(pubkey = PUBKEY): Nip05Result {
  return { status: "found", pubkey };
}

function makeUserResolver(relays: string[] = ["wss://relay.example"]): UserResolver {
  const resolver = new UserResolver([], [], 10, 1000);
  vi.spyOn(resolver, "getDmRelays").mockResolvedValue(relays);
  return resolver;
}

/** Awaits `promise`, asserting it rejects with an LmtpError, and returns it. */
async function captureLmtpError(promise: Promise<unknown>): Promise<LmtpError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof LmtpError) return err;
    throw err;
  }
  throw new Error("expected handleMessage to reject, but it resolved");
}

describe("handleMessage", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedPublish.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("550s when there is no recipient — Postfix bounces to the real sender", async () => {
    const resolver = makeUserResolver();
    const err = await captureLmtpError(handleMessage(RAW, undefined, resolver));
    expect(err.responseCode).toBe(550);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("550s when NIP-05 lookup returns not-found — the address does not exist", async () => {
    mockedLookup.mockResolvedValue({ status: "not-found" });
    const resolver = makeUserResolver();
    const err = await captureLmtpError(
      handleMessage(RAW, "ghost@mailstr.app", resolver),
    );
    expect(err.responseCode).toBe(550);
  });

  it("451s when NIP-05 lookup errors — transient, Postfix must retry", async () => {
    mockedLookup.mockResolvedValue({ status: "error", message: "ECONNREFUSED" });
    const resolver = makeUserResolver();
    const err = await captureLmtpError(
      handleMessage(RAW, "alice@mailstr.app", resolver),
    );
    expect(err.responseCode).toBe(451);
  });

  it("resolves normally when at least one relay accepts the publish", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockResolvedValue(true);
    const resolver = makeUserResolver();
    await expect(
      handleMessage(RAW, "alice@mailstr.app", resolver),
    ).resolves.toBeUndefined();
  });

  it("451s when publishMail resolves false and there is nothing to strip", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockResolvedValue(false);
    const resolver = makeUserResolver();
    const err = await captureLmtpError(
      handleMessage(RAW, "alice@mailstr.app", resolver),
    );
    expect(err.responseCode).toBe(451);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
  });

  it("451s when publishMail throws and there is nothing to strip", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockRejectedValue(new Error("relay pool blew up"));
    const resolver = makeUserResolver();
    const err = await captureLmtpError(
      handleMessage(RAW, "alice@mailstr.app", resolver),
    );
    expect(err.responseCode).toBe(451);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
  });

  it("retries without attachments — as attachments_error.txt — when the full message is rejected", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const resolver = makeUserResolver();

    await expect(
      handleMessage(await buildRawWithAttachment(), "alice@mailstr.app", resolver),
    ).resolves.toBeUndefined();

    expect(mockedPublish).toHaveBeenCalledTimes(2);
    const retryRaw: string = mockedPublish.mock.calls[1][0].raw;
    const parsed = await simpleParser(Buffer.from(retryRaw, "latin1"));
    expect(parsed.attachments.map((a) => a.filename)).toContain("attachments_error.txt");
    expect(parsed.attachments[0].content.toString("utf8")).toContain(
      "Attachments are still a work in progress",
    );
    // Identity/threading survives the rebuild.
    expect(parsed.messageId).toBe("<attached@example.com>");
  });

  it("retries without attachments when the publish throws, and 451s if the retry also fails", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish
      .mockRejectedValueOnce(new Error("message too large"))
      .mockResolvedValueOnce(false);
    const resolver = makeUserResolver();

    const err = await captureLmtpError(
      handleMessage(await buildRawWithAttachment(), "alice@mailstr.app", resolver),
    );
    expect(err.responseCode).toBe(451);
    expect(mockedPublish).toHaveBeenCalledTimes(2);
  });

  // The OOM fix: a message whose wrap would exceed most relays' caps is not
  // even attempted. `config.relayMaxEventBytes` defaults to 100 KiB and
  // wrapping inflates ~2.4x, so the ceiling is ~42 KB of raw message. The
  // full publish for a big attachment used to be built anyway and OOM-killed
  // the 128 MB container while sealing, before any relay saw the event.
  // (Relays did already reject oversized events implicitly, but only after
  // the memory had been spent — and one permissive relay could still "accept"
  // it, so the old outcome was either an OOM, an endless 451, or a delivery
  // visible to almost nobody.)
  it("skips the full publish entirely for a message over the wrap ceiling, and strips instead", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockResolvedValue(true);
    const resolver = makeUserResolver();

    // ~1 MB of attachment, far over the ceiling.
    const big = await buildRawWithAttachment(1024 * 1024);
    expect(big.byteLength).toBeGreaterThan(512 * 1024);

    await expect(
      handleMessage(big, "alice@mailstr.app", resolver),
    ).resolves.toBeUndefined();

    // Exactly one publish, and it was the stripped copy — never the original.
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const publishedRaw: string = mockedPublish.mock.calls[0][0].raw;
    expect(Buffer.byteLength(publishedRaw, "latin1")).toBeLessThan(50_000);
    const parsed = await simpleParser(Buffer.from(publishedRaw, "latin1"));
    expect(parsed.attachments.map((a) => a.filename)).toContain("attachments_error.txt");
  });

  it("552s a message that is still over the ceiling after stripping — permanent, not retried", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockResolvedValue(true);
    const resolver = makeUserResolver();

    // A huge plain-text body: nothing to strip, so the message stays too big.
    const hugeText = [
      "From: bob@example.com",
      "To: alice@mailstr.app",
      "Subject: huge body",
      "",
      "x".repeat(200_000),
    ].join("\r\n");

    const err = await captureLmtpError(
      handleMessage(Buffer.from(hugeText, "utf8"), "alice@mailstr.app", resolver),
    );
    expect(err.responseCode).toBe(552);
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("552s an over-ceiling message whose stripped form is still too big", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockResolvedValue(true);
    const resolver = makeUserResolver();

    // An attachment to strip, but also a body so large the rebuilt message
    // remains over the ceiling.
    const composer = new MailComposer({
      from: "bob@example.com",
      to: "alice@mailstr.app",
      subject: "huge plus attachment",
      text: "y".repeat(200_000),
      attachments: [{ filename: "big.bin", content: Buffer.alloc(1024 * 1024, 1) }],
      messageId: "<huge-att@example.com>",
      date: new Date("2026-01-01T00:00:00Z"),
    });
    const raw: Buffer = await composer.compile().build();

    const err = await captureLmtpError(
      handleMessage(raw, "alice@mailstr.app", resolver),
    );
    expect(err.responseCode).toBe(552);
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("passes the byte-string form of the raw message to publishMail, not UTF-8-decoded text", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockResolvedValue(true);
    const resolver = makeUserResolver();
    // 0xE9 is not valid UTF-8 on its own; a UTF-8 decode would replace it
    // with U+FFFD before this ever reaches publishMail.
    const rawWithLatin1Byte = Buffer.from([0x63, 0x61, 0x66, 0xe9]);

    await handleMessage(rawWithLatin1Byte, "alice@mailstr.app", resolver);

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0][0];
    expect(call.raw).toBe("café");
  });
});
