import { describe, it, expect } from "vitest";
import {
  CHUNK_RUMOR_JSON_BUDGET,
  chunkTags,
  hashMessage,
  readChunkMeta,
  reassembleChunks,
  splitMessage,
} from "./chunked-mail.js";
import { buildMailRumor, unwrapAndVerify } from "./mail.js";
import { bytesToMessageString } from "./bytes.js";
import { keySigner } from "./key-signer.js";
import { buildInboundChunkWraps } from "../nostr-publisher.js";

const SENDER = keySigner(new Uint8Array(32).fill(0x11));
const RECIPIENT = keySigner(new Uint8Array(32).fill(0x22));
const SENDER_PUB = await SENDER.getPublicKey();
const RECIPIENT_PUB = await RECIPIENT.getPublicKey();

function utf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Encode-width of a slice inside the same rumor shape the publisher builds. */
function rumorBytes(content: string, msgid: string, total: number, totalBytes: number): number {
  const rumor = buildMailRumor({
    senderPubkey: SENDER_PUB,
    recipientPubkey: RECIPIENT_PUB,
    rfc2822: content,
    wrapSecret: new Uint8Array(32),
    extraTags: chunkTags(msgid, 0, total, totalBytes),
  });
  return utf8(JSON.stringify(rumor));
}

function textLines(total: number): string {
  let out = "";
  while (out.length < total) out += "x".repeat(74) + "\r\n";
  return out.slice(0, total);
}

function eightBit(total: number): string {
  const bytes = new Uint8Array(total);
  for (let i = 0; i < total; i++) bytes[i] = 0xc0 + (i % 0x3f);
  return bytesToMessageString(bytes);
}

describe("splitMessage", () => {
  it("keeps a message that already fits as a single slice", async () => {
    const raw = "From: a@b\r\nSubject: small\r\n\r\nhello";
    const split = await splitMessage(raw, {
      senderPubkey: SENDER_PUB,
      recipientPubkey: RECIPIENT_PUB,
    });

    expect(split.slices).toEqual([raw]);
    expect(split.totalBytes).toBe(raw.length);
    expect(split.msgid).toBe(await hashMessage(raw));
  });

  it("splits a large body into maximal, budget-respecting chunks", async () => {
    const raw = "a".repeat(200_000);
    const { slices, msgid, totalBytes } = await splitMessage(raw, {
      senderPubkey: SENDER_PUB,
      recipientPubkey: RECIPIENT_PUB,
    });

    expect(slices.length).toBeGreaterThan(1);
    expect(slices.join("")).toBe(raw);
    expect(totalBytes).toBe(raw.length);

    for (let i = 0; i < slices.length; i++) {
      expect(rumorBytes(slices[i], msgid, slices.length, totalBytes)).toBeLessThanOrEqual(
        CHUNK_RUMOR_JSON_BUDGET,
      );
      // Maximality: one more byte would exceed the budget, except for the
      // final slice (which is bounded by what is left of the message).
      if (i < slices.length - 1) {
        expect(
          rumorBytes(slices[i] + "a", msgid, slices.length, totalBytes),
        ).toBeGreaterThan(CHUNK_RUMOR_JSON_BUDGET);
      }
    }
  });

  it("budgets encoded bytes, not raw bytes (8-bit body needs more chunks)", async () => {
    const ascii = "a".repeat(60_000);
    const high = eightBit(60_000);
    const params = { senderPubkey: SENDER_PUB, recipientPubkey: RECIPIENT_PUB };

    const asciiSplit = await splitMessage(ascii, params);
    const highSplit = await splitMessage(high, params);

    expect(highSplit.slices.length).toBeGreaterThanOrEqual(asciiSplit.slices.length * 1.5);
    // Each 8-bit chunk still fits: the splitter measured JSON, not raw bytes.
    for (const slice of highSplit.slices) {
      expect(rumorBytes(slice, highSplit.msgid, highSplit.slices.length, highSplit.totalBytes))
        .toBeLessThanOrEqual(CHUNK_RUMOR_JSON_BUDGET);
    }
  });

  it("accounts for CRLF escaping in line-based bodies", async () => {
    const raw = textLines(120_000);
    const split = await splitMessage(raw, {
      senderPubkey: SENDER_PUB,
      recipientPubkey: RECIPIENT_PUB,
    });

    expect(split.slices.length).toBeGreaterThan(1);
    expect(split.slices.join("")).toBe(raw);
    for (const slice of split.slices) {
      expect(rumorBytes(slice, split.msgid, split.slices.length, split.totalBytes))
        .toBeLessThanOrEqual(CHUNK_RUMOR_JSON_BUDGET);
    }
  });
});

describe("reassembleChunks", () => {
  async function partsFor(raw: string) {
    const { slices, msgid, totalBytes } = await splitMessage(raw, {
      senderPubkey: SENDER_PUB,
      recipientPubkey: RECIPIENT_PUB,
    });
    return slices.map((content, i) => ({
      tags: chunkTags(msgid, i, slices.length, totalBytes),
      content,
    }));
  }

  it("reassembles out of order and ignores duplicates", async () => {
    const raw = textLines(90_000);
    const parts = await partsFor(raw);

    const shuffled = [...parts].reverse();
    const withDuplicates = [shuffled[0], shuffled[0], ...shuffled.slice(1)];

    const result = await reassembleChunks(withDuplicates);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.raw).toBe(raw);
  });

  it("reports which indices are missing", async () => {
    const parts = await partsFor("z".repeat(90_000));
    const result = await reassembleChunks(parts.filter((_, i) => i !== 2));

    expect(result).toEqual({
      ok: false,
      reason: "incomplete",
      missing: [2],
      msgid: expect.any(String),
    });
  });

  it("fails on a tampered chunk instead of returning corrupt mail", async () => {
    const parts = await partsFor("q".repeat(90_000));
    const target = { ...parts[1], content: parts[1].content.slice(0, -1) + "Z" };

    const result = await reassembleChunks([parts[0], target, ...parts.slice(2)]);
    expect(result).toEqual({
      ok: false,
      reason: "hash-mismatch",
      msgid: expect.any(String),
    });
  });

  it("refuses to merge chunks from different messages", async () => {
    const a = await partsFor("a".repeat(60_000));
    const b = await partsFor("b".repeat(60_000));

    const result = await reassembleChunks([...a, ...b]);
    expect(result).toEqual({
      ok: false,
      reason: "conflict",
      msgid: expect.any(String),
    });
  });

  it("returns incomplete for non-chunk input", async () => {
    const result = await reassembleChunks([
      { tags: [["p", RECIPIENT_PUB]], content: "hello" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("incomplete");
  });
});

describe("readChunkMeta", () => {
  it("ignores non-chunk tags", () => {
    expect(readChunkMeta([["p", RECIPIENT_PUB]])).toBeNull();
  });

  it("rejects malformed indices", () => {
    expect(readChunkMeta([["chunk", "abc", "3", "2"], ["chunk-size", "10"]])).toBeNull();
    expect(readChunkMeta([["chunk", "abc", "x", "2"], ["chunk-size", "10"]])).toBeNull();
  });
});

describe("wrapped chunks", () => {
  it("keeps every kind-1059 under 64 KiB and round-trips through unwrap", async () => {
    const raw = "a".repeat(200_000);
    const prepared = await buildInboundChunkWraps({
      raw,
      recipientPubkey: RECIPIENT_PUB,
      signer: SENDER,
    });

    expect(prepared.wraps.length).toBeGreaterThan(1);
    expect(prepared.msgid).toBe(await hashMessage(raw));

    for (const wrap of prepared.wraps) {
      expect(utf8(JSON.stringify(wrap))).toBeLessThanOrEqual(64 * 1024);
    }
    // The whole point of the 28 672 budget: we use the largest padding step
    // that fits, not a conservative fraction of it.
    const largest = Math.max(...prepared.wraps.map((w) => utf8(JSON.stringify(w))));
    expect(largest).toBeGreaterThan(50_000);

    // Decrypt as the recipient and reassemble the actual delivered bytes.
    const parts = [];
    for (const wrap of prepared.wraps) {
      const unwrapped = await unwrapAndVerify(wrap, RECIPIENT, {
        maxAgeSeconds: 3 * 24 * 3600,
      });
      expect(unwrapped.ok).toBe(true);
      if (!unwrapped.ok) throw new Error(unwrapped.reason);
      parts.push({ tags: unwrapped.rumor.tags, content: unwrapped.rumor.content });
    }

    const result = await reassembleChunks(parts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.raw).toBe(raw);
      expect(result.msgid).toBe(prepared.msgid);
    }
  });
});
