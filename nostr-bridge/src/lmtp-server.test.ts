import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

  it("451s when publishMail resolves false — no relay accepted, never 250", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockResolvedValue(false);
    const resolver = makeUserResolver();
    const err = await captureLmtpError(
      handleMessage(RAW, "alice@mailstr.app", resolver),
    );
    expect(err.responseCode).toBe(451);
  });

  it("451s when publishMail throws", async () => {
    mockedLookup.mockResolvedValue(foundResult());
    mockedPublish.mockRejectedValue(new Error("relay pool blew up"));
    const resolver = makeUserResolver();
    const err = await captureLmtpError(
      handleMessage(RAW, "alice@mailstr.app", resolver),
    );
    expect(err.responseCode).toBe(451);
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
