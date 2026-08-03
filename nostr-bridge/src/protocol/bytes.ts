/**
 * Convert between raw message bytes and the "byte string" representation
 * used for `rumor.content` (§4 "Content is a byte string" in
 * docs/ARCHITECTURE.md): a JS string in which every code unit is exactly
 * one octet (0-255) of the original RFC 2822 message.
 *
 * Mail is bytes, not text — a message declares its own charset in
 * `Content-Type`, and real senders still emit ISO-8859-1, Shift-JIS and
 * other 8-bit encodings. Decoding those bytes as UTF-8 (or any other text
 * encoding) before this point is lossy and unrecoverable. These two
 * functions are the only place that conversion may happen, so the bridge,
 * the browser client and the e2e suite all agree on one representation.
 *
 * No Node built-ins here (no `Buffer`, no `node:*`): this file is bundled
 * into the browser client by Vite.
 */

// Chosen well under typical JS engine argument-count/stack limits so
// `String.fromCharCode(...chunk)` never overflows the call stack, even for
// multi-megabyte messages.
const CHUNK_SIZE = 0x2000; // 8192

/** Each octet of `bytes` becomes one UTF-16 code unit (0-255) of the result. */
export function bytesToMessageString(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    result += String.fromCharCode(...chunk);
  }
  return result;
}

/**
 * Inverse of `bytesToMessageString`. Masks each code unit with `& 0xff`:
 * a well-formed byte string never needs it (every code unit is already
 * 0-255), but it keeps this total rather than silently truncating to
 * garbage if a caller ever passes a real (non-byte-string) unicode string.
 */
export function messageStringToBytes(content: string): Uint8Array {
  const bytes = new Uint8Array(content.length);
  for (let i = 0; i < content.length; i++) {
    bytes[i] = content.charCodeAt(i) & 0xff;
  }
  return bytes;
}
