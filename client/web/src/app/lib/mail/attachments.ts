import type { File as DriveFile } from '@formstr/drive-sdk'
import { resolveSharedAttachment } from './shareLinkResolve'
import type { Attachment } from '@/app/types/mail'

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

function hexToBytes(hex: string, expected: number, label: string): Uint8Array<ArrayBuffer> {
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
 * A filename safe to hand a download. Lives with the save-to-disk machinery in
 * `lib/saveFile.ts` — re-exported here for the attachment callers and tests.
 *
 * The sender chooses this string. Path separators would let it escape the
 * downloads directory on clients that honour them, and a leading dot hides
 * the file. Everything questionable is replaced rather than rejected, so a
 * hostile name still downloads under a harmless one.
 */
export { safeFilename } from '@/app/lib/saveFile'

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
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, blob as unknown as ArrayBuffer)
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
 * Inline MIME parts already carry their bytes. A drive share link needs no
 * key from the message: the link itself is the bearer token. Blossom-hosted
 * files are fetched on demand and decrypted when the sender supplied a key.
 * Two encrypted formats exist: the legacy one-shot AES-GCM (key + nonce) the
 * bridge used to write, and the NIP-FS / drive-sdk segment format
 * (key + `x`/`ox`/`size`) the bridge writes now.
 */
export async function resolveAttachment(attachment: Attachment): Promise<Uint8Array> {
  if (attachment.data) return attachment.data

  if (attachment.shareUrl) return resolveSharedAttachment(attachment.shareUrl)

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

  if (!attachment.blossomKey) return blob

  // Legacy: one AES-256-GCM blob, nonce carried in the tag.
  if (attachment.blossomNonce) {
    return decryptAttachment(blob, attachment.blossomKey, attachment.blossomNonce)
  }

  // NIP-FS: segmented ciphertext whose nonces are derived from segment index.
  if (
    attachment.blossomBlobHash &&
    attachment.blossomFileHash &&
    attachment.size !== undefined
  ) {
    return decryptDriveAttachment({
      blob,
      url: attachment.blossomUrl,
      filename: attachment.filename,
      contentType: attachment.contentType,
      key: attachment.blossomKey,
      blobHash: attachment.blossomBlobHash,
      fileHash: attachment.blossomFileHash,
      size: attachment.size,
    })
  }

  // A key with no usable scheme is malformed, not "hosted in the clear" —
  // returning the ciphertext would hand the reader an unopenable file.
  throw new Error('Attachment is missing the fields needed to decrypt it')
}

/**
 * Decrypt a NIP-FS blob with the drive-sdk. `decryptFileBytes` verifies both
 * the ciphertext hash and the plaintext hash, so a tampered or truncated blob
 * fails rather than producing garbage.
 */
async function decryptDriveAttachment(input: {
  blob: Uint8Array
  url: string
  filename: string
  contentType: string
  key: string
  blobHash: string
  fileHash: string
  size: number
}): Promise<Uint8Array> {
  // Loaded on demand: the drive-sdk is only needed for this format.
  const { DEFAULT_CHUNK_SIZE, decryptFileBytes } = await import('@formstr/drive-sdk')

  const file: DriveFile = {
    name: input.filename || 'attachment',
    type: input.contentType || 'application/octet-stream',
    parent: '',
    uploadedAt: 0,
    servers: [input.url],
    encryptionKey: input.key,
    encryptionAlgorithm: 'aes-gcm',
    blobHash: input.blobHash,
    unencryptedFileHash: input.fileHash,
    size: input.size,
    chunkSize: DEFAULT_CHUNK_SIZE,
  }
  return decryptFileBytes(input.blob, file)
}

/** Hand bytes to the user as a file — browser download on the web, the native
 * share sheet inside the Capacitor app (where an anchor download does
 * nothing). Shared with the PGP key export and the account key backup. */
export { saveToDisk } from '@/app/lib/saveFile'
