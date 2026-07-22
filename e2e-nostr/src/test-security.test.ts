import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, getEventHash } from "nostr-tools/pure";
import {
  keySigner,
  sealAndWrap,
  unwrapAndVerify,
  buildMailRumor,
  KIND_MAIL,
} from "@nostr-bridge/protocol/index.js";
import { authorizeSender, selectDeliverTargets } from "@nostr-bridge/outbound.js";

const LOCAL = ["mailstr.app"];

describe("sender spoofing", () => {
  /**
   * The attack this whole design exists to stop.
   *
   * nostr-tools' `unwrapEvent` decrypts both layers but discards the seal and
   * never checks that the rumor's author matches it. So an attacker seals with
   * a key they genuinely hold while claiming to be someone else in the rumor,
   * and any bridge authorizing on `rumor.pubkey` sends mail as the victim.
   */
  it("rejects a rumor whose author does not match the seal", async () => {
    const bridgeSk = generateSecretKey();
    const bridgePk = getPublicKey(bridgeSk);
    const alicePk = getPublicKey(generateSecretKey());
    const mallorySk = generateSecretKey();

    const forged: Record<string, unknown> = {
      kind: KIND_MAIL,
      pubkey: alicePk, // the lie
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", bridgePk],
        ["deliver", "victim@example.com"],
      ],
      content: "From: alice@mailstr.app\r\nTo: victim@example.com\r\n\r\nsend money",
    };
    forged.id = getEventHash(forged as never);

    const wrap = await sealAndWrap(forged as never, bridgePk, keySigner(mallorySk));
    const result = await unwrapAndVerify(wrap, keySigner(bridgeSk));

    expect(result).toEqual({ ok: false, reason: "author-mismatch" });
  });

  it("refuses a From address the sealing key does not own", async () => {
    const alicePk = getPublicKey(generateSecretKey());
    const malloryPk = getPublicKey(generateSecretKey());

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ names: { alice: alicePk } }))) as typeof fetch;

    const result = await authorizeSender({
      from: "alice@mailstr.app",
      sealPubkey: malloryPk,
      localDomains: LOCAL,
    });

    expect(result.ok).toBe(false);
  });

  it("accepts a From address the sealing key does own", async () => {
    const alicePk = getPublicKey(generateSecretKey());

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ names: { alice: alicePk } }))) as typeof fetch;

    const result = await authorizeSender({
      from: "alice@mailstr.app",
      sealPubkey: alicePk,
      localDomains: LOCAL,
    });

    expect(result).toEqual({ ok: true, address: "alice@mailstr.app" });
  });

  // The bridge must not be usable to inject into local mailboxes: those are
  // reachable over Nostr, and relaying here would bypass the inbound rules.
  it("refuses to relay into its own domains", () => {
    const { deliver, rejected } = selectDeliverTargets(
      ["bob@example.org", "eve@mailstr.app"],
      LOCAL,
    );
    expect(deliver).toEqual(["bob@example.org"]);
    expect(rejected).toEqual(["eve@mailstr.app"]);
  });
});

describe("multi-recipient routing", () => {
  // One wrap, N deliver tags — previously N wraps meant recipient #1 got N
  // copies and everyone else got nothing.
  it("carries every legacy recipient in a single wrap", async () => {
    const bridgeSk = generateSecretKey();
    const bridgePk = getPublicKey(bridgeSk);
    const aliceSk = generateSecretKey();
    const signer = keySigner(aliceSk);

    const rumor = buildMailRumor({
      senderPubkey: await signer.getPublicKey(),
      recipientPubkey: bridgePk,
      rfc2822: "From: alice@mailstr.app\r\nTo: b@example.org\r\n\r\nhi",
      deliverTo: ["b@example.org", "c@example.net", "d@example.com"],
    });
    const wrap = await sealAndWrap(rumor, bridgePk, signer);

    const result = await unwrapAndVerify(wrap, keySigner(bridgeSk));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { deliver } = selectDeliverTargets(
      result.rumor.tags.filter((t) => t[0] === "deliver").map((t) => t[1]),
      LOCAL,
    );
    expect(deliver).toHaveLength(3);
  });
});
