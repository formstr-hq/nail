/**
 * Inbound attachment offload over the Formstr Drive protocol.
 *
 * The attachment is encrypted with `@formstr/drive-sdk` (NIP-FS segmented
 * AES-256-GCM) and uploaded to Blossom. A `shared-file` event carries the
 * encrypted file metadata, and the link to it is what the recipient receives:
 *
 *   https://drive.formstr.app/#shared=<naddr>&k=<share secret>
 *
 * Both the upload and the share event use throwaway keys, so a public Blossom
 * server and the relays never learn the bridge's identity. The link is a
 * bearer token: possession of the URL is the only access control. Anyone who
 * can read the mail can resolve and decrypt the file, exactly as with the old
 * `imeta` key/nonce pair. There is no per-recipient ACL and the bridge does not
 * revoke or delete the share after delivery.
 */

import {
  buildEvent,
  createFetchBlossomTransport,
  deriveBlobKey,
  encodeShareLink,
  encryptFile,
  uploadEncryptedFile,
  type FileSigner,
} from "@formstr/drive-sdk";
import type { Event } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { config } from "./config.js";
import { publishToRelay } from "./nostr-publisher.js";
import { keySigner } from "./protocol/key-signer.js";

const DRIVE_SHARE_BASE_URL =
  (process.env.DRIVE_SHARE_BASE_URL ?? "https://drive.formstr.app/").replace(/\/+$/, "") + "/";
const PUBLISH_TIMEOUT_MS = 20_000;

export interface DriveShareAttachment {
  filename: string;
  mimeType: string;
  size: number;
  shareUrl: string;
  server: string;
}

function ephemeralSigner(secretKey: Uint8Array): FileSigner {
  return {
    getPublicKey: async () => getPublicKey(secretKey),
    signEvent: async (template) => finalizeEvent(template, secretKey),
  };
}

function randomDTag(): string {
  return `s-${bytesToHex(crypto.getRandomValues(new Uint8Array(4)))}`;
}

async function publishShare(
  event: Event,
  relays: readonly string[],
  timeoutMs: number,
): Promise<string[]> {
  const signer = keySigner(config.bridgePrivkey);
  const results = await Promise.all(
    relays.map(async (relay) => {
      try {
        return (await publishToRelay(relay, event, signer, timeoutMs)) ? relay : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((relay): relay is string => relay !== null);
}

/**
 * Encrypt one attachment, upload it, publish its share event, and return the
 * drive link. Returns null on any failure so the caller can fall back to the
 * existing strip-with-notice path.
 */
export async function uploadDriveShare(
  plaintext: Uint8Array,
  input: { filename: string; mimeType: string },
  options: {
    servers: readonly string[];
    relays: readonly string[];
    deadline: number;
  },
): Promise<DriveShareAttachment | null> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const encrypted = await encryptFile(plaintext);
    const upload = await uploadEncryptedFile(encrypted, {
      signer: ephemeralSigner(generateSecretKey()),
      transport: createFetchBlossomTransport(),
      servers: options.servers,
      signal: controller.signal,
    });

    const server = upload.landed[0];
    if (!server) {
      console.warn(
        `nostr-bridge: drive upload failed for ${input.filename}: ` +
          (upload.failures
            .map((f) => `${f.server}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
            .join("; ") || "no server accepted"),
      );
      return null;
    }

    const shareSecretHex = bytesToHex(generateSecretKey());
    const signingKey = generateSecretKey();
    const d = randomDTag();
    const event = buildEvent({
      subtype: "shared-file",
      d,
      payload: {
        id: bytesToHex(crypto.getRandomValues(new Uint8Array(4))),
        name: input.filename || "attachment",
        type: input.mimeType || "application/octet-stream",
        parent: "",
        folder: "",
        uploadedAt: Date.now(),
        servers: [server],
        server,
        encryptionKey: encrypted.encryptionKey,
        encryptionAlgorithm: "aes-gcm",
        blobHash: encrypted.blobHash,
        unencryptedFileHash: encrypted.unencryptedFileHash,
        size: encrypted.size,
        chunkSize: encrypted.chunkSize,
      },
      conversationKey: deriveBlobKey(shareSecretHex),
      signingKey,
      client: "mailstr-bridge",
    });

    const publishTimeout = Math.max(
      1_000,
      Math.min(PUBLISH_TIMEOUT_MS, options.deadline - Date.now()),
    );
    const accepted = await publishShare(event, options.relays, publishTimeout);
    if (accepted.length === 0) {
      console.warn(
        `nostr-bridge: could not publish the share link for ${input.filename} to any relay`,
      );
      return null;
    }

    return {
      filename: input.filename || "attachment",
      mimeType: input.mimeType || "application/octet-stream",
      size: encrypted.size,
      shareUrl: encodeShareLink({
        pubkey: getPublicKey(signingKey),
        d,
        relays: accepted,
        secretKeyHex: shareSecretHex,
        baseUrl: DRIVE_SHARE_BASE_URL,
      }),
      server,
    };
  } catch (error) {
    console.warn(
      `nostr-bridge: drive attachment offload failed for ${input.filename}: ` +
        `${(error as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
