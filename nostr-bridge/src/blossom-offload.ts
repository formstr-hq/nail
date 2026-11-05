/**
 * Inbound attachment offload.
 *
 * A message that cannot fit one gift wrap used to have its attachments dropped
 * (with an `attachments_error.txt` notice). That loses the file even when the
 * sender and recipient both have Blossom servers available.
 *
 * This path encrypts each attachment, uploads it to Blossom, and puts the
 * resulting `imeta` tags on the rumor. The reader's client already renders
 * hosted attachments (fetch + AES-GCM decrypt), so no client change is needed.
 *
 * Server order, per product requirement:
 *   1. the recipient's own BUD-03 `kind:10063` servers, in order;
 *   2. if they have none, or every one of theirs fails, the operator's
 *      `BLOSSOM_SERVER_URL`.
 *
 * Any failure (no server accepts, parse/rebuild fails) returns null and the
 * caller keeps the existing strip-and-notice fallback: the mail still arrives,
 * just without the file.
 */

import { simpleParser, type Attachment } from "mailparser";
import type { Event } from "nostr-tools";
import { config } from "./config.js";
import { uploadEncryptedAttachment, type UploadedAttachment } from "./blossom-client.js";
import { RelayWebSocket } from "./relay-socket.js";
import { isPgpMime, stripAttachments } from "./stripAttachments.js";

const SERVER_QUERY_TIMEOUT_MS = 5_000;
const UPLOAD_TIMEOUT_MS = 90_000;
/** Total time one attachment may spend trying servers before the strip fallback. */
const UPLOAD_BUDGET_MS = 240_000;
const MAX_SERVER_QUERIES = 8;

export interface OffloadResult {
  /** The message rebuilt without its attachments (byte-string representation). */
  raw: string;
  /** `imeta` tags to put on the rumor (every chunk carries them). */
  tags: string[][];
}

function normalizeServer(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** User servers first, operator server last; normalized and de-duplicated. */
export function blossomCandidates(userServers: readonly string[], envServer: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const server = normalizeServer(raw);
    if (server && !out.includes(server)) out.push(server);
  };
  for (const server of userServers) add(server);
  add(envServer);
  return out;
}

/** The `imeta` tag shape `parseImetaTags` and the client's AttachmentRow read. */
export function imetaTags(attachment: Attachment, uploaded: UploadedAttachment): string[] {
  const tags = [
    "imeta",
    `url ${uploaded.url}`,
    `m ${attachment.contentType || "application/octet-stream"}`,
    `filename ${attachment.filename || "attachment"}`,
  ];
  if (typeof attachment.size === "number") tags.push(`size ${attachment.size}`);
  tags.push(
    `decryption-key ${uploaded.encryptionKey}`,
    `decryption-nonce ${uploaded.decryptionNonce}`,
    `x ${uploaded.sha256}`,
  );
  return tags;
}

/** One REQ against one relay; resolves with whatever arrived before EOSE/timeout. */
function queryRelay(
  relayUrl: string,
  filter: Record<string, unknown>,
  timeoutMs: number,
): Promise<Event[]> {
  return new Promise((resolve) => {
    const events: Event[] = [];
    const subscription = `blossom-${Math.random().toString(36).slice(2)}`;
    const ws = new RelayWebSocket(relayUrl);
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(events);
    };

    const timer = setTimeout(finish, timeoutMs);
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify(["REQ", subscription, filter]));
      } catch {
        finish();
      }
    });
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as unknown;
        if (!Array.isArray(data)) return;
        if (data[0] === "EVENT" && data[1] === subscription && data[2]) {
          events.push(data[2] as Event);
        } else if (data[0] === "EOSE" && data[1] === subscription) {
          finish();
        }
      } catch {
        // ignore malformed frames
      }
    });
    ws.on("error", finish);
    ws.on("close", finish);
  });
}

/**
 * The recipient's BUD-03 server list, newest `kind:10063` event across their
 * DM relays plus the bridge's relays. Empty list means "use the operator's".
 */
export async function fetchBlossomServers(
  pubkey: string,
  relays: readonly string[],
): Promise<string[]> {
  const targets = [...new Set([...relays, ...config.bridgeRelays])].slice(0, MAX_SERVER_QUERIES);
  if (targets.length === 0) return [];

  const results = await Promise.all(
    targets.map((relay) =>
      queryRelay(
        relay,
        { kinds: [10063], authors: [pubkey], limit: 1 },
        SERVER_QUERY_TIMEOUT_MS,
      ).catch(() => [] as Event[]),
    ),
  );

  const latest = results
    .flat()
    .filter((event) => event.kind === 10063 && event.pubkey === pubkey)
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return [];

  return latest.tags
    .filter((tag) => tag[0] === "server" && typeof tag[1] === "string")
    .map((tag) => tag[1]!.trim())
    .filter(Boolean);
}

async function uploadOne(
  plaintext: Buffer,
  candidates: readonly string[],
  recipient: string,
): Promise<{ uploaded: UploadedAttachment; server: string } | null> {
  const deadline = Date.now() + UPLOAD_BUDGET_MS;
  for (const server of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const uploaded = await uploadEncryptedAttachment(
        plaintext,
        config.bridgePrivkey,
        server,
        Math.min(UPLOAD_TIMEOUT_MS, remaining),
      );
      console.log(
        `nostr-bridge: uploaded attachment for ${recipient} to ${server} ` +
          `(${plaintext.length} bytes)`,
      );
      return { uploaded, server };
    } catch (error) {
      console.warn(
        `nostr-bridge: Blossom upload to ${server} failed for ${recipient}: ` +
          `${(error as Error).message}`,
      );
    }
  }
  return null;
}

/**
 * Encrypt and upload every attachment, then rebuild the message without them.
 * Returns null when the message fits a wrap, has nothing to offload, is
 * PGP/MIME, or any upload fails (the caller then strips with the notice).
 */
export async function offloadAttachments(
  raw: Buffer,
  params: {
    recipientPubkey: string;
    relays: readonly string[];
    recipient: string;
    /** Test/integration seam; production leaves this undefined and queries 10063. */
    userServers?: string[];
  },
): Promise<OffloadResult | null> {
  // Only the over-ceiling case would otherwise strip; leave small inline
  // attachments alone so they keep travelling inside the wrap.
  if (raw.length <= config.maxWrappableMessageBytes) return null;

  let parsed;
  try {
    parsed = await simpleParser(raw);
  } catch (error) {
    console.warn(
      `nostr-bridge: attachment offload parse failed for ${params.recipient}: ` +
        `${(error as Error).message}`,
    );
    return null;
  }
  if (parsed.attachments.length === 0 || isPgpMime(parsed)) return null;

  let userServers: string[] = params.userServers ?? [];
  if (params.userServers === undefined) {
    try {
      userServers = await fetchBlossomServers(params.recipientPubkey, params.relays);
    } catch (error) {
      console.warn(
        `nostr-bridge: Blossom server lookup failed for ${params.recipient}: ` +
          `${(error as Error).message}`,
      );
    }
  }
  const candidates = blossomCandidates(userServers, config.blossomServerUrl);
  if (candidates.length === 0) return null;

  const tags: string[][] = [];
  for (const attachment of parsed.attachments) {
    const bytes = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(attachment.content);
    const uploaded = await uploadOne(bytes, candidates, params.recipient);
    if (!uploaded) return null;
    tags.push(imetaTags(attachment, uploaded.uploaded));
  }

  let stripped: string | null;
  try {
    stripped = await stripAttachments(raw, { notice: false });
  } catch (error) {
    console.warn(
      `nostr-bridge: rebuild after upload failed for ${params.recipient}: ` +
        `${(error as Error).message}`,
    );
    return null;
  }
  if (!stripped) return null;

  console.log(
    `nostr-bridge: offloaded ${tags.length} attachment(s) for ${params.recipient}; ` +
      "delivering the body with imeta links",
  );
  return { raw: stripped, tags };
}
