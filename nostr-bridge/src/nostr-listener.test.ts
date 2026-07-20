import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SimplePool } from "nostr-tools/pool";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

// config.ts throws at module load if LOCAL_DOMAINS is unset, and parses
// NOSTR_BRIDGE_NSEC into a real secp256k1 key eagerly. Both must be set
// before nostr-listener.ts (which imports config.ts) is evaluated — see the
// identical vi.hoisted block in lmtp-server.test.ts.
vi.hoisted(() => {
  process.env.LOCAL_DOMAINS = "mailstr.app";
  // 32 bytes of 0x11 — well under curve order, nonzero, valid hex privkey.
  process.env.NOSTR_BRIDGE_NSEC = "11".repeat(32);
});

vi.mock("./nip05.js", () => ({ lookupNip05: vi.fn() }));

import { handleWrap } from "./nostr-listener.js";
import { lookupNip05, type Nip05Result } from "./nip05.js";
import { config } from "./config.js";
import { keySigner } from "./protocol/key-signer.js";
import { buildMailRumor, sealAndWrap } from "./protocol/mail.js";
import { bytesToMessageString, messageStringToBytes } from "./protocol/bytes.js";
import type { createPostfixTransport } from "./smtp-injector.js";

const mockedLookup = vi.mocked(lookupNip05);

function actor() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), signer: keySigner(sk) };
}

function fakePool(): SimplePool {
  return { publish: vi.fn(() => []) } as unknown as SimplePool;
}

function fakeTransport() {
  return { sendMail: vi.fn().mockResolvedValue(undefined) } as unknown as ReturnType<
    typeof createPostfixTransport
  > & { sendMail: ReturnType<typeof vi.fn> };
}

function foundResult(pubkey: string): Nip05Result {
  return { status: "found", pubkey };
}

describe("handleWrap", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // §4 "Content is a byte string": rumor.content is a byte string (one code
  // unit per octet), never UTF-8 text. If the outbound path handed
  // nodemailer that string directly, nodemailer would encode it as UTF-8 and
  // corrupt every non-ASCII byte. 0xE9 (the ISO-8859-1 "é") is not valid
  // UTF-8 on its own, so any accidental re-encoding would show up here as a
  // mismatch against the original bytes.
  it("hands the injector byte-identical content for a non-ASCII message", async () => {
    const alice = actor();
    const bridgePubkey = config.bridgePubkey;

    const originalBytes = new Uint8Array([
      ...Buffer.from(
        [
          "From: alice@mailstr.app",
          "To: bob@gmail.com",
          "Subject: caf\xe9 test",
          "Content-Type: text/plain; charset=iso-8859-1",
          "",
          "",
        ].join("\r\n"),
        "binary",
      ),
      0x63, 0x61, 0x66, 0xe9, // "caf" + 0xE9
    ]);
    const byteStringContent = bytesToMessageString(originalBytes);

    mockedLookup.mockResolvedValue(foundResult(alice.pk));

    const rumor = buildMailRumor({
      senderPubkey: alice.pk,
      recipientPubkey: bridgePubkey,
      rfc2822: byteStringContent,
      deliverTo: ["bob@gmail.com"],
    });
    const wrap = await sealAndWrap(rumor, bridgePubkey, alice.signer);

    const transport = fakeTransport();
    await handleWrap(fakePool(), ["wss://relay.example"], transport, wrap);

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    const mailOptions = transport.sendMail.mock.calls[0][0];
    expect(mailOptions.envelope).toEqual({ from: "alice@mailstr.app", to: ["bob@gmail.com"] });

    const sentBytes = new Uint8Array(mailOptions.raw as Buffer);
    expect(sentBytes).toEqual(originalBytes);
    // Guard against a vacuous pass: prove the raw buffer is NOT what you'd
    // get from a lossy UTF-8 round trip of the byte string.
    expect(Buffer.from(byteStringContent, "utf8")).not.toEqual(Buffer.from(sentBytes));
    // And confirm it matches what the protocol module's own decoder produces.
    expect(messageStringToBytes(rumor.content)).toEqual(originalBytes);
  });
});
