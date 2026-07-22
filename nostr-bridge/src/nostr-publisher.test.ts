import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { keySigner } from "./protocol/key-signer.js";
import { unwrapAndVerify } from "./protocol/mail.js";
import { buildInboundWrap } from "./nostr-publisher.js";

const RAW = [
  "From: Bob <bob@gmail.com>",
  "To: alice@mailstr.app",
  "Subject: lunch?",
  "Message-ID: <abc@gmail.com>",
  "",
  "are you free thursday",
].join("\r\n");

describe("buildInboundWrap", () => {
  it("preserves the original RFC 2822 byte for byte", async () => {
    const bridgeSk = generateSecretKey();
    const aliceSk = generateSecretKey();
    const alicePk = getPublicKey(aliceSk);

    const wrap = await buildInboundWrap(RAW, alicePk, keySigner(bridgeSk));
    const result = await unwrapAndVerify(wrap, keySigner(aliceSk));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The whole point: From, Message-ID and every other header survive, so
    // the recipient can reply and threading works.
    expect(result.rumor.content).toBe(RAW);
    expect(result.seal.pubkey).toBe(getPublicKey(bridgeSk));
  });

  it("carries no deliver tags — inbound mail is not for relaying", async () => {
    const bridgeSk = generateSecretKey();
    const aliceSk = generateSecretKey();

    const wrap = await buildInboundWrap(RAW, getPublicKey(aliceSk), keySigner(bridgeSk));
    const result = await unwrapAndVerify(wrap, keySigner(aliceSk));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rumor.tags.filter((t) => t[0] === "deliver")).toEqual([]);
  });
});
