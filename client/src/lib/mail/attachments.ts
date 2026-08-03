import type { Attachment } from '@/types/mail'

/**
 * Blossom-hosted attachments, fetched and decrypted client-side.
 *
 * Every input here comes from the sender: the URL, the filename, the key and
 * the nonce all arrive in an `imeta` tag on a message anyone may have written.
 * Each is validated before use rather than trusted.
 *
 * The scheme mirrors `nostr-bridge/src/blossom-client.ts` exactly —
 * AES-256-GCM, a 32-byte key, a 12-byte IV, and the 16-byte auth tag appended
 * to the ciphertext. Node's `createCipheriv` output and WebCrypto's AES-GCM
 * both use that layout, so the two sides interoperate without a shim.
 */

const KEY_BYTES = 32
const IV_BYTES = 12
/** AES-GCM cannot be authenticated with fewer bytes than its tag. */
const MIN_BLOB_BYTES = 16

function hexToBytes(hex: string, expected: number, label: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length !== expected * 2) {
    throw new Error(`Attachment ${label} is malformed`)
  }
  const out = new Uint8Array(expected)
  for (let i = 0; i < expected; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Only https, and only when the URL parses.
 *
 * A sender picks this host, so fetching it reveals the reader's IP — that is
 * inherent to downloading, and acceptable because a download is an explicit
 * action. What is not acceptable is following a `javascript:` or `file:` URL,
 * or letting a plain-http host see the request.
 */
function assertFetchableUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Attachment link is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Attachment link is not https, so it was not opened')
  }
}

/**
 * A filename safe to hand a download.
 *
 * The sender chooses this string. Path separators would let it escape the
 * downloads directory on clients that honour them, and a leading dot hides
 * the file. Everything questionable is replaced rather than rejected, so a
 * hostile name still downloads under a harmless one.
 *
 * Two classes of invisible character are stripped, for different reasons:
 *
 *  - C0 controls and DEL, which can truncate or corrupt the name downstream.
 *  - Bidirectional overrides. A name containing U+202E renders in the save
 *    dialog with its extension reversed - "invoice<RLO>fdp.exe" reads as
 *    "invoiceexe.pdf" while staying an executable on disk, so stripping
 *    C0 alone leaves the extension-spoofing trick fully intact.
 */
const UNSAFE_INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function safeFilename(name: string): string {
  const flattened = name
    .replace(/[/\\]/g, '_')
    .replace(UNSAFE_INVISIBLE, '')
    .replace(/^\.+/, '')
    .trim()
  return flattened.slice(0, 200) || 'attachment'
}

/** Human-readable size. Returns null when the size is not yet known. */
export function formatSize(bytes: number | undefined): string | null {
  if (bytes === undefined || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function decryptAttachment(
  blob: Uint8Array,
  keyHex: string,
  nonceHex: string,
): Promise<Uint8Array> {
  if (blob.byteLength < MIN_BLOB_BYTES) {
    throw new Error('Attachment is too short to be authentic')
  }
  const rawKey = hexToBytes(keyHex, KEY_BYTES, 'key')
  const iv = hexToBytes(nonceHex, IV_BYTES, 'nonce')

  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt'])
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, blob)
    return new Uint8Array(plain)
  } catch {
    // GCM authentication failed: the blob was altered, truncated, or the key
    // does not belong to it. Never fall back to returning the raw bytes.
    throw new Error('Attachment failed its integrity check and was not opened')
  }
}

/**
 * The attachment's bytes, wherever they live.
 *
 * Inline MIME parts already carry their bytes. Blossom-hosted ones are fetched
 * on demand, and decrypted when the sender supplied a key — `parseImetaTags`
 * allows attachments hosted in the clear, so an absent key is legitimate
 * rather than an error.
 */
export async function resolveAttachment(attachment: Attachment): Promise<Uint8Array> {
  if (attachment.data) return attachment.data

  if (!attachment.blossomUrl) {
    throw new Error('This attachment has no contents and no link to fetch')
  }
  assertFetchableUrl(attachment.blossomUrl)

  // fetch rejects rather than resolving when the host is unreachable, DNS
  // fails, or the server sends no CORS header — all of which surface as a
  // bare "Failed to fetch". Name the host instead, since that is the only
  // part the reader can act on.
  const host = new URL(attachment.blossomUrl).host
  let res: Response
  try {
    res = await fetch(attachment.blossomUrl, { referrerPolicy: 'no-referrer' })
  } catch {
    throw new Error(`Could not reach ${host}. The file may have been removed, or the host may be blocking downloads from the browser.`)
  }
  if (!res.ok) {
    throw new Error(`${host} refused the download (${res.status}).`)
  }
  const blob = new Uint8Array(await res.arrayBuffer())

  if (!attachment.blossomKey || !attachment.blossomNonce) return blob
  return decryptAttachment(blob, attachment.blossomKey, attachment.blossomNonce)
}

/** Hand bytes to the browser as a download. */
export function saveToDisk(bytes: Uint8Array, filename: string, contentType: string): void {
  // The sender also chose contentType. It only labels the blob here — nothing
  // renders it — but keep it off the "runs in a tab" path regardless.
  const blob = new Blob([bytes as BlobPart], { type: contentType || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = safeFilename(filename)
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
