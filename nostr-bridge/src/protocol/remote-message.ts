/**
 * Pointer metadata for a whole message stored outside the gift wrap.
 *
 * The normal mail rumor stays small: original headers + a short notice. The
 * complete RFC 822 message is encrypted with the Formstr Drive SDK and uploaded
 * to Blossom; this tag is how a Mailstr client finds and decrypts it.
 *
 * The tag lives inside the sealed rumor, so the bearer link and blob metadata
 * are visible only to the recipient.
 */
export const REMOTE_TAG = "remote";
export const REMOTE_PROVIDER_BLOSSOM = "blossom";

export interface RemoteMessageMeta {
  v: 1;
  provider: typeof REMOTE_PROVIDER_BLOSSOM;
  servers: string[];
  encryptionKey: string;
  blobHash: string;
  fileHash: string;
  size: number;
  chunkSize: number;
  filename: string;
  mimeType: string;
  shareUrl: string;
  /** Uploader key, used to authorize a best-effort Blossom delete. */
  deleteKey?: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

/** Parse and validate the remote tag. Returns null for any old/malformed tag. */
export function parseRemoteMessageTag(tags: string[][]): RemoteMessageMeta | null {
  const tag = tags.find((t) => t[0] === REMOTE_TAG);
  if (!tag || tag[1] !== REMOTE_PROVIDER_BLOSSOM || typeof tag[2] !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(tag[2]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (
    m.v !== 1 ||
    m.provider !== REMOTE_PROVIDER_BLOSSOM ||
    !isStringArray(m.servers) ||
    m.servers.some((s) => !/^https?:\/\//i.test(s)) ||
    typeof m.encryptionKey !== "string" ||
    typeof m.blobHash !== "string" ||
    typeof m.fileHash !== "string" ||
    typeof m.size !== "number" ||
    typeof m.chunkSize !== "number" ||
    typeof m.filename !== "string" ||
    typeof m.mimeType !== "string" ||
    typeof m.shareUrl !== "string" ||
    (m.deleteKey !== undefined && typeof m.deleteKey !== "string")
  ) {
    return null;
  }
  return {
    v: 1,
    provider: REMOTE_PROVIDER_BLOSSOM,
    servers: m.servers,
    encryptionKey: m.encryptionKey,
    blobHash: m.blobHash,
    fileHash: m.fileHash,
    size: m.size,
    chunkSize: m.chunkSize,
    filename: m.filename,
    mimeType: m.mimeType,
    shareUrl: m.shareUrl,
    ...(typeof m.deleteKey === "string" ? { deleteKey: m.deleteKey } : {}),
  };
}

export function remoteMessageTag(meta: RemoteMessageMeta): string[] {
  return [REMOTE_TAG, meta.provider, JSON.stringify(meta)];
}
