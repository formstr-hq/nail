import { localRelayStore } from './driveStore'
import { DEFAULT_RELAYS } from '@/app/lib/nostr/constants'

/**
 * Resolve a drive share link into the same plaintext bytes a direct `imeta`
 * attachment yields.
 *
 * The drive-sdk does the protocol work: fetch the `shared-file` event from the
 * link's relay hints, decrypt its metadata with the link's `k`, then download
 * and decrypt the NIP-FS blob. No signer is needed — the blob is encrypted and
 * the key is in the link.
 *
 * Resolution is online-only unless the local relay already has the share
 * event; there is no prefetch. A failed download is retryable once the relay
 * or Blossom server is reachable again.
 */
export async function resolveSharedAttachment(shareUrl: string): Promise<Uint8Array> {
  const { createFetchBlossomTransport, downloadFile, resolveShare } = await import(
    '@formstr/drive-sdk'
  )

  try {
    const resolved = await resolveShare(shareUrl, {
      store: localRelayStore(),
      // The link carries the relays the share event actually landed on; these
      // are extra hints for the case where the reader doesn't already follow
      // the sender's relay set.
      relays: DEFAULT_RELAYS,
    })
    if (resolved.kind === 'revoked') {
      throw new Error('This shared attachment was revoked by its sender.')
    }

    const blob = await downloadFile(resolved.file, {
      transport: createFetchBlossomTransport(),
    })
    return new Uint8Array(await blob.arrayBuffer())
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not open the shared attachment: ${reason}`)
  }
}
