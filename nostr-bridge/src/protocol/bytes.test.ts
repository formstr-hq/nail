import { describe, it, expect } from "vitest";
import { bytesToMessageString, messageStringToBytes } from "./bytes.js";

/**
 * The real pipeline puts `rumor.content` through JSON (the rumor is
 * JSON.stringify'd before NIP-44 encryption, and JSON.parse'd after
 * decryption). A conversion that "round-trips" in isolation but breaks
 * under JSON escaping would still corrupt every message, so every fidelity
 * assertion here goes through this helper rather than testing the two
 * functions in isolation.
 */
function roundTripThroughJson(bytes: Uint8Array): Uint8Array {
  const content = bytesToMessageString(bytes);
  const wire = JSON.stringify({ content });
  const parsed = JSON.parse(wire) as { content: string };
  return messageStringToBytes(parsed.content);
}

function allBytes(): Uint8Array {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  return bytes;
}

describe("bytesToMessageString / messageStringToBytes", () => {
  it("round-trips all 256 byte values exactly through JSON", () => {
    const bytes = allBytes();
    expect(roundTripThroughJson(bytes)).toEqual(bytes);
  });

  it("round-trips an ISO-8859-1 body byte (0xE9, 'é' in Latin-1)", () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "caf" + 0xE9
    expect(roundTripThroughJson(bytes)).toEqual(bytes);
  });

  it("round-trips a UTF-8 multi-byte sequence (0xC3 0xA9, 'é' in UTF-8)", () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]); // "caf" + UTF-8 é
    expect(roundTripThroughJson(bytes)).toEqual(bytes);
  });

  it("round-trips a Shift-JIS sequence (0x93 0xFA 0x96 0x7B, '日本' in Shift-JIS)", () => {
    const bytes = new Uint8Array([0x93, 0xfa, 0x96, 0x7b]);
    expect(roundTripThroughJson(bytes)).toEqual(bytes);
  });

  it("produces one code unit per byte with values 0-255 only", () => {
    const bytes = allBytes();
    const str = bytesToMessageString(bytes);
    expect(str.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(str.charCodeAt(i)).toBe(i);
    }
  });

  it("does not overflow the call stack on a large message", () => {
    const bytes = new Uint8Array(2_000_000).fill(0x41);
    let str = "";
    expect(() => {
      str = bytesToMessageString(bytes);
    }).not.toThrow();
    expect(str.length).toBe(bytes.length);
    expect(messageStringToBytes(str)).toEqual(bytes);
  });

  it("round-trips an empty message", () => {
    const bytes = new Uint8Array(0);
    expect(bytesToMessageString(bytes)).toBe("");
    expect(messageStringToBytes("")).toEqual(bytes);
  });

  it("masks code units above 0xff instead of producing an out-of-range byte", () => {
    // A caller accidentally passing a real (non-byte-string) unicode string
    // must not throw or silently overflow Uint8Array's clamping in a way
    // that hides the bug — it masks to the low byte.
    expect(messageStringToBytes("Ā")).toEqual(new Uint8Array([0])); // 256 & 0xff = 0
    expect(messageStringToBytes("ǩ")).toEqual(new Uint8Array([0xe9])); // 489 & 0xff = 233
  });
});
