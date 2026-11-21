import type { Event } from "nostr-tools";
import { generateSecretKey, getEventHash } from "nostr-tools/pure";
import { config } from "./config.js";
import { buildMailRumor, sealAndWrap } from "./protocol/mail.js";
import { remoteMessageTag, type RemoteMessageMeta } from "./protocol/remote-message.js";
import type { ProtocolSigner } from "./protocol/types.js";
import { blossomCandidates, fetchBlossomServers } from "./blossom-offload.js";
import { uploadDriveShare } from "./drive-share.js";

const REMOTE_UPLOAD_BUDGET_MS = 240_000;

function headerEnd(raw: Buffer): number {
  const crlf = raw.indexOf(Buffer.from("\r\n\r\n"));
  const lf = raw.indexOf(Buffer.from("\n\n"));
  if (crlf === -1 && lf === -1) return raw.length;
  if (crlf === -1) return lf;
  if (lf === -1) return crlf;
  return Math.min(crlf, lf);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A small RFC 822 pointer that keeps the original identity and threading
 * headers but replaces the body with a notice and the bearer link. Old clients
 * can still show the notice and open the link in Formstr Drive.
 */
export function buildRemotePointer(raw: Buffer, meta: RemoteMessageMeta): string {
  const end = headerEnd(raw);
  const headers = raw.subarray(0, end).toString("latin1").split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;

  for (const line of headers) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    const lower = line.toLowerCase();
    if (lower.startsWith("content-") || lower.startsWith("mime-version:")) {
      skipping = true;
      continue;
    }
    skipping = false;
    if (line.trim()) kept.push(line);
  }

  const body = [
    "This message is too large to deliver inline.",
    `It is encrypted and stored on Blossom (${formatSize(meta.size)}).`,
    "",
    "Open it in Mailstr to download and read the full message.",
    "",
    `Full message: ${meta.shareUrl}`,
  ].join("\r\n");

  return [
    ...kept,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
}

/**
 * Encrypt the complete RFC 822 message, upload it to Blossom, and build the
 * small pointer wrap. The caller publishes the returned wrap.
 */
export async function buildRemoteMessage(params: {
  raw: Buffer;
  recipientPubkey: string;
  relays: string[];
  signer: ProtocolSigner;
  /** Preserve the message's original date for archive imports. */
  createdAt?: number;
  /** Override the Blossom candidates; otherwise use BUD-03 + operator default. */
  servers?: string[];
}): Promise<{ wrap: Event; meta: RemoteMessageMeta } | null> {
  let servers = params.servers;
  if (!servers?.length) {
    let userServers: string[] = [];
    try {
      userServers = await fetchBlossomServers(params.recipientPubkey, params.relays);
    } catch (error) {
      console.warn(
        `nostr-bridge: Blossom server lookup failed for remote message: ` +
          `${(error as Error).message}`,
      );
    }
    servers = blossomCandidates(userServers, config.blossomServerUrl);
  }

  const candidateServers = [...new Set(servers.filter(Boolean))];
  if (candidateServers.length === 0) return null;

  const shared = await uploadDriveShare(
    params.raw,
    { filename: "message.eml", mimeType: "message/rfc822" },
    {
      servers: candidateServers,
      relays: params.relays,
      deadline: Date.now() + REMOTE_UPLOAD_BUDGET_MS,
    },
  );
  if (!shared) return null;

  const meta: RemoteMessageMeta = {
    v: 1,
    provider: "blossom",
    servers: shared.servers,
    encryptionKey: shared.encryptionKey,
    blobHash: shared.blobHash,
    fileHash: shared.unencryptedFileHash,
    size: shared.size,
    chunkSize: shared.chunkSize,
    filename: shared.filename,
    mimeType: shared.mimeType,
    shareUrl: shared.shareUrl,
    deleteKey: shared.deleteKey,
  };

  const pointer = buildRemotePointer(params.raw, meta);
  const ephemeralSk = generateSecretKey();
  const rumor = buildMailRumor({
    senderPubkey: await params.signer.getPublicKey(),
    recipientPubkey: params.recipientPubkey,
    rfc2822: pointer,
    wrapSecret: ephemeralSk,
    extraTags: [remoteMessageTag(meta)],
  });
  if (params.createdAt !== undefined) {
    rumor.created_at = params.createdAt;
    rumor.id = getEventHash(rumor);
  }

  return {
    wrap: await sealAndWrap(rumor, params.recipientPubkey, params.signer, {
      ephemeralSk,
    }),
    meta,
  };
}
