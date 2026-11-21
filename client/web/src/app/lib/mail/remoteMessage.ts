import type { Event } from 'nostr-tools'
import type { ActiveSigner } from '@formstr/signer'
import type { File as DriveFile, FileSigner } from '@formstr/drive-sdk'
import { createBlossomAuthorization, createFetchBlossomTransport } from '@formstr/drive-sdk'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import {
  bytesToMessageString,
  REMOTE_TAG,
  type RemoteMessageMeta,
  type Rumor,
} from '@protocol'
import { decodeRumor } from './receive'
import type { Email } from '@/app/types/mail'

function blobUrl(server: string, hash: string): URL {
  const base = server.replace(/\/+$/, '')
  return new URL(`${base}/${hash}`)
}

/** Adapt the active signer to the drive-sdk's minimal signer interface. */
function activeFileSigner(active: ActiveSigner): FileSigner {
  return {
    getPublicKey: () => active.getPublicKey(),
    signEvent: (template) => active.signEvent(template),
  }
}

async function getAuthorization(
  signer: FileSigner,
  hash: string,
): Promise<string> {
  return createBlossomAuthorization(
    signer,
    'get',
    [hash],
    'Download Mailstr remote message',
    600,
    () => Math.floor(Date.now() / 1000),
  )
}

/**
 * Fetch the encrypted full RFC 822 message from one of the Blossom servers in
 * the pointer, decrypt it with the drive-sdk, and return the plaintext bytes.
 * `decryptFileBytes` verifies both the ciphertext hash and plaintext hash, so a
 * truncated or swapped blob is rejected instead of rendered as corrupt mail.
 */
export async function fetchRemoteMessage(
  remote: RemoteMessageMeta,
  active?: ActiveSigner | null,
): Promise<Uint8Array> {
  const { decryptFileBytes } = await import('@formstr/drive-sdk')
  let lastError: unknown
  // #117 pinning servers may require a get token signed by the recipient.
  // Public servers ignore it; the extra header is harmless.
  const authorization = active
    ? await getAuthorization(activeFileSigner(active), remote.blobHash)
    : undefined

  for (const server of remote.servers) {
    let url: URL
    try {
      url = blobUrl(server, remote.blobHash)
    } catch {
      continue
    }
    if (url.protocol !== 'https:') continue

    let response: Response
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      response = await fetch(url.toString(), {
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
        ...(authorization ? { headers: { Authorization: authorization } } : {}),
      })
    } catch (error) {
      lastError = error
      continue
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      lastError = new Error(`${url.host} refused the message (${response.status})`)
      continue
    }

    const blob = new Uint8Array(await response.arrayBuffer())
    const file: DriveFile = {
      name: remote.filename || 'message.eml',
      type: remote.mimeType || 'message/rfc822',
      parent: '',
      uploadedAt: 0,
      servers: [server],
      encryptionKey: remote.encryptionKey,
      encryptionAlgorithm: 'aes-gcm',
      blobHash: remote.blobHash,
      unencryptedFileHash: remote.fileHash,
      size: remote.size,
      chunkSize: remote.chunkSize,
    }
    try {
      return await decryptFileBytes(blob, file)
    } catch (error) {
      lastError = error
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `Could not load the full message: ${lastError.message}`
      : 'Could not load the full message from any Blossom server.',
  )
}

/**
 * Re-decode the downloaded original using the pointer's identity/threading
 * metadata. The remote tag is dropped so the resulting Email is a normal,
 * fully-loaded message; `loaded` is retained for UI state.
 */
export async function decodeRemoteEmail(
  email: Email,
  raw: Uint8Array,
  ownPubkey: string | null,
): Promise<Email> {
  if (!email.remote) return email
  const tags = (email.debug?.rumor.tags ?? []).filter((tag) => tag[0] !== REMOTE_TAG)
  const rumor: Rumor = {
    id: email.id,
    kind: 1301,
    pubkey: email.senderPubkey,
    created_at: email.timestamp,
    tags,
    content: bytesToMessageString(raw),
  }
  const decoded = await decodeRumor(
    rumor,
    { pubkey: email.senderPubkey } as Event,
    ownPubkey,
    { id: email.id },
  )
  if ('failure' in decoded) {
    throw new Error(`Downloaded message could not be parsed (${decoded.failure.reason})`)
  }
  return {
    ...decoded.email,
    remote: { ...email.remote, loaded: true },
  }
}

/**
 * Best-effort Blob deletion when the user permanently deletes the pointer.
 *
 * The bridge retains the upload key in the encrypted pointer metadata. That key
 * is the same one that authorized the upload, so the recipient can ask each
 * Blossom server to delete the ciphertext without involving the bridge. Servers
 * are not obliged to honor deletion; failures are reported to the caller but do
 * not block the local mail deletion.
 */
async function deleteWithSigner(
  remote: RemoteMessageMeta,
  signer: FileSigner,
): Promise<{ deleted: number; failed: number }> {
  const transport = createFetchBlossomTransport()
  const deleteBlob = transport.delete?.bind(transport)
  if (!deleteBlob) return { deleted: 0, failed: remote.servers.length }
  const authorization = await createBlossomAuthorization(
    signer,
    'delete',
    [remote.blobHash],
    'Delete Mailstr remote message',
    600,
    () => Math.floor(Date.now() / 1000),
  )

  let deleted = 0
  let failed = 0
  for (const server of remote.servers) {
    try {
      await deleteBlob({ server, hash: remote.blobHash, authorization })
      deleted += 1
    } catch {
      failed += 1
    }
  }
  return { deleted, failed }
}

export async function deleteRemoteMessage(
  remote: RemoteMessageMeta,
  active?: ActiveSigner | null,
): Promise<{ deleted: number; failed: number }> {
  // Compliant servers pin the blob for the recipient, so their own delete
  // authorization removes it. Non-compliant servers ignored the pin, so retain
  // the upload-key fallback. Try both when available; delete is idempotent.
  const recipient = active
    ? await deleteWithSigner(remote, activeFileSigner(active))
    : null
  if (remote.deleteKey) {
    const secret = hexToBytes(remote.deleteKey)
    const uploader: FileSigner = {
      getPublicKey: async () => getPublicKey(secret),
      signEvent: async (template) => finalizeEvent(template, secret),
    }
    const fallback = await deleteWithSigner(remote, uploader)
    return fallback
  }
  return recipient ?? { deleted: 0, failed: 0 }
}
