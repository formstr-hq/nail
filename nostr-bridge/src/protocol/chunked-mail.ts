/**
 * Chunked delivery for bodies that cannot fit one gift wrap.
 *
 * Why this exists: NIP-44 v2 caps a single plaintext at 65 535 bytes
 * (`MAX_PLAINTEXT_BYTES`), and NIP-59 wraps the seal inside a *second*
 * NIP-44 layer. A single kind-1059 therefore cannot carry more than ~28 KB
 * of RFC 2822 message no matter what the relay allows. Attachments have
 * Blossom; a large body has nowhere else to go, so it is split.
 *
 * Sizing is not a guess. Measured against the real wrap code (2026-11-04):
 *
 *   raw ASCII 28 275 B -> event 55 134 B
 *   raw CRLF  27 586 B -> event 55 134 B
 *   raw 8-bit 14 156 B -> event 55 134 B
 *   one byte more      -> event 66 058 B   (over a 64 KiB relay cap)
 *
 * The jump is NIP-44's padding quantisation: `calcPaddedLen` rounds to
 * `nextPower/8` steps, so with a 65 536-byte event cap the usable sizes are
 * 55 134 and 66 058 — nothing in between. The invariant that produces
 * 55 134 is the *inner* plaintext (the rumor JSON) staying at or below
 * 28 672 bytes (32768 * 7/8). Everything here is therefore budgeted in
 * encoded JSON bytes, not raw bytes: a latin1 body consumes twice the budget
 * per byte that ASCII does, and the splitter must not care.
 *
 * Browser-safe: no Buffer, no node:* imports. This module is bundled into the
 * client (which reassembles what the bridge sends), so the only primitives
 * used are TextEncoder and Web Crypto (`crypto.subtle.digest`), both present
 * in Node >= 19 and every secure-context browser.
 */

import { buildMailRumor } from "./mail.js";
import { messageStringToBytes } from "./bytes.js";

/** Largest rumor JSON (UTF-8 bytes) that still yields a <= 64 KiB wrap. */
export const CHUNK_RUMOR_JSON_BUDGET = 28_672;

/** Tag naming a chunk: `["chunk", <sha256 of whole raw>, <i>, <n>]`. */
export const CHUNK_TAG = "chunk";
/** Tag carrying the total raw length of the split message. */
export const CHUNK_SIZE_TAG = "chunk-size";

/**
 * Indices are zero-padded to a fixed width so that the budget measurement
 * (which includes the tag text) does not depend on how many chunks the
 * message turns out to need. Clients parse them as integers.
 */
const INDEX_WIDTH = 3;

export interface ChunkMeta {
  msgid: string;
  index: number;
  total: number;
  totalBytes: number;
}

export interface SplitMessage {
  /** sha256 of the whole raw message, hex. Doubles as the reassembly key. */
  msgid: string;
  /** Total raw byte length (the byte-string's length). */
  totalBytes: number;
  /** Byte-string slices in order; concatenation reproduces the input. */
  slices: string[];
}

export type ReassemblyResult =
  | { ok: true; raw: string; msgid: string }
  | {
      ok: false;
      reason: "incomplete" | "conflict" | "hash-mismatch" | "size-mismatch";
      /** Indices never seen, for "incomplete". */
      missing?: number[];
      msgid?: string;
    };

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** sha256 of the message's raw bytes, hex-encoded. */
export async function hashMessage(raw: string): Promise<string> {
  const bytes = messageStringToBytes(raw);
  // Copy into a fresh ArrayBuffer-backed view: Web Crypto's BufferSource type
  // does not accept a Uint8Array over a possibly-shared buffer.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return toHex(new Uint8Array(digest));
}

function padIndex(value: number): string {
  return String(value).padStart(INDEX_WIDTH, "0");
}

/**
 * The tags that make a mail rumor a chunk. Shared by the splitter (which must
 * measure them) and the publisher (which writes them), so the two can never
 * drift apart.
 */
export function chunkTags(
  msgid: string,
  index: number,
  total: number,
  totalBytes: number,
): string[][] {
  return [
    [CHUNK_TAG, msgid, padIndex(index), padIndex(total)],
    [CHUNK_SIZE_TAG, String(totalBytes)],
  ];
}

/** Read chunk metadata from rumor tags, or null when this is not a chunk. */
export function readChunkMeta(tags: string[][]): ChunkMeta | null {
  const tag = tags.find((t) => t[0] === CHUNK_TAG);
  if (!tag || tag.length < 4) return null;

  const index = Number(tag[2]);
  const total = Number(tag[3]);
  if (!Number.isInteger(index) || !Number.isInteger(total)) return null;
  if (index < 0 || total <= 0 || index >= total) return null;

  const sizeTag = tags.find((t) => t[0] === CHUNK_SIZE_TAG);
  const totalBytes = sizeTag ? Number(sizeTag[1]) : Number.NaN;
  if (!Number.isInteger(totalBytes) || totalBytes < 0) return null;

  return { msgid: tag[1], index, total, totalBytes };
}

interface MeasureParams {
  senderPubkey: string;
  recipientPubkey: string;
  msgid: string;
  totalBytes: number;
  /** Extra rumor tags every chunk carries (e.g. inbound `imeta`). */
  extraTags?: string[][];
}

/**
 * Exact JSON length of the rumor that would carry `content`.
 *
 * Built through the real `buildMailRumor` (with a throwaway 32-byte wrap key
 * of the same length the publisher uses) rather than by re-deriving the JSON
 * shape: if the protocol adds a tag or renames a field, the budget follows
 * automatically instead of silently overflowing the event cap.
 */
function rumorJsonBytes(content: string, params: MeasureParams): number {
  const rumor = buildMailRumor({
    senderPubkey: params.senderPubkey,
    recipientPubkey: params.recipientPubkey,
    rfc2822: content,
    wrapSecret: new Uint8Array(32),
    // `total` is fixed at the widest 3-digit value: every 3-digit string is
    // the same length, so the measurement is independent of the real count.
    extraTags: [
      ...chunkTags(params.msgid, 0, 999, params.totalBytes),
      ...(params.extraTags ?? []),
    ],
  });
  return utf8Length(JSON.stringify(rumor));
}

/**
 * Split a raw (byte-string) message into slices that each fit one wrap.
 *
 * Returns a single slice when the message already fits — callers must not
 * assume `slices.length > 1`.
 */
export async function splitMessage(
  raw: string,
  params: {
    senderPubkey: string;
    recipientPubkey: string;
    extraTags?: string[][];
  },
): Promise<SplitMessage> {
  const totalBytes = messageStringToBytes(raw).length;
  const msgid = await hashMessage(raw);
  const measure = { ...params, msgid, totalBytes };

  const fits = (content: string): boolean =>
    rumorJsonBytes(content, measure) <= CHUNK_RUMOR_JSON_BUDGET;

  if (fits(raw)) return { msgid, totalBytes, slices: [raw] };

  const slices: string[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const remaining = raw.length - offset;
    // A single octet of content is always under budget (the budget is ~28 KB
    // and the fixed overhead is ~450 B), so this cannot underflow silently.
    if (!fits(raw.slice(offset, offset + 1))) {
      throw new Error("chunk budget smaller than rumor overhead");
    }

    let lo = 1;
    let hi = remaining;
    while (lo < hi) {
      // Upper-mid: `lo = mid` must make progress on a two-element window.
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(raw.slice(offset, offset + mid))) lo = mid;
      else hi = mid - 1;
    }
    slices.push(raw.slice(offset, offset + lo));
    offset += lo;
  }

  return { msgid, totalBytes, slices };
}

/**
 * Reassemble chunks into the original message.
 *
 * Pure and transport-agnostic: the caller supplies whatever it received
 * (duplicates included) and decides what to render. Duplicates are ignored;
 * out-of-order parts are fine; anything that disagrees with the group, is
 * incomplete, or fails the hash check is reported rather than guessed at.
 */
export async function reassembleChunks(
  parts: Array<{ tags: string[][]; content: string }>,
): Promise<ReassemblyResult> {
  const metas = parts
    .map((p) => ({ meta: readChunkMeta(p.tags), content: p.content }))
    .filter((p): p is { meta: ChunkMeta; content: string } => p.meta !== null);

  if (metas.length === 0) return { ok: false, reason: "incomplete", missing: [] };

  const msgid = metas[0].meta.msgid;
  const total = metas[0].meta.total;
  const totalBytes = metas[0].meta.totalBytes;

  // A second group cannot be merged into this one: same index from another
  // message would silently corrupt the output.
  if (metas.some((m) => m.meta.msgid !== msgid)) {
    return { ok: false, reason: "conflict", msgid };
  }
  if (metas.some((m) => m.meta.total !== total || m.meta.totalBytes !== totalBytes)) {
    return { ok: false, reason: "conflict", msgid };
  }

  const byIndex = new Map<number, string>();
  for (const { meta, content } of metas) {
    const existing = byIndex.get(meta.index);
    if (existing !== undefined && existing !== content) {
      return { ok: false, reason: "conflict", msgid };
    }
    byIndex.set(meta.index, content);
  }

  const missing: number[] = [];
  for (let i = 0; i < total; i++) if (!byIndex.has(i)) missing.push(i);
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing, msgid };

  const raw = Array.from({ length: total }, (_, i) => byIndex.get(i)).join("");
  if (messageStringToBytes(raw).length !== totalBytes) {
    return { ok: false, reason: "size-mismatch", msgid };
  }
  if ((await hashMessage(raw)) !== msgid) {
    return { ok: false, reason: "hash-mismatch", msgid };
  }

  return { ok: true, raw, msgid };
}
