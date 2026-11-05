import type { Event } from "nostr-tools";
import { generateSecretKey } from "nostr-tools/pure";
import { buildMailRumor, sealAndWrap } from "./protocol/mail.js";
import { chunkTags, splitMessage } from "./protocol/chunked-mail.js";
import type { ProtocolSigner } from "./protocol/types.js";
import { KIND_CLIENT_AUTH } from "./protocol/constants.js";
import { RelayWebSocket as WebSocket } from "./relay-socket.js";

/** A relay declining a write until we authenticate (NIP-42). */
function isAuthRequired(reason: unknown): boolean {
  return typeof reason === "string" && /^(auth-required|restricted)/i.test(reason);
}

/**
 * Publish one event to one relay, resolving true only on an explicit
 * `["OK", id, true]`.
 *
 * If the relay demands NIP-42 auth — either by pushing an `["AUTH", challenge]`
 * frame or rejecting the EVENT with an `auth-required` reason — the bridge signs
 * a kind-22242 event with its own key, sends `["AUTH", ...]`, and resends the
 * mail event once. A relay that never accepts falls through to the timeout.
 */
// Exported for testing against a stubbed relay, the same pattern the listener
// uses for handleWrap. Callers should go through publishMail.
export function publishToRelay(
  relayUrl: string,
  event: Event,
  signer: ProtocolSigner,
  timeoutMs = 4000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let challenge: string | null = null;
    let authEventId: string | null = null;
    let authAttempted = false;
    // Why the relay said no, for the caller's log — a bare `false` cannot
    // distinguish "too large" (the attachment case) from "blocked: spam",
    // and the LMTP fallback path makes that distinction worth keeping.
    let rejection: string | undefined;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (!result && rejection) {
        console.warn(`nostr-bridge: relay ${relayUrl} rejected ${event.id.slice(0, 8)}: ${rejection}`);
      }
      resolve(result);
    };

    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => finish(false), timeoutMs);

    // A send on a CONNECTING socket throws synchronously. Both call sites are
    // EventEmitter callbacks (`on("open")`, a resend after AUTH), where a
    // throw would escape as an uncaughtException and take the bridge down.
    // A rejected relay is a normal failure: log and settle false.
    const sendEvent = () => {
      try {
        ws.send(JSON.stringify(["EVENT", event]));
      } catch (error) {
        console.error(`nostr-bridge: relay ${relayUrl} send failed:`, (error as Error).message);
        finish(false);
      }
    };

    // Only ever authenticate once per connection: relays that keep rejecting
    // after a valid AUTH are refusing us for some other reason, and retrying
    // would just spin until the timeout.
    const authenticate = async () => {
      if (authAttempted || challenge === null) return;
      authAttempted = true;
      try {
        const authEvent = await signer.signEvent({
          kind: KIND_CLIENT_AUTH,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          content: "",
          pubkey: await signer.getPublicKey(),
        });
        authEventId = authEvent.id;
        try {
          ws.send(JSON.stringify(["AUTH", authEvent]));
        } catch {
          finish(false);
        }
      } catch (error) {
        console.error(`nostr-bridge: relay ${relayUrl} auth failed:`, (error as Error).message);
        finish(false);
      }
    };

    ws.on("open", () => sendEvent());
    ws.on("message", (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed relay frames
      }
      if (!Array.isArray(data)) return;

      if (data[0] === "AUTH" && typeof data[1] === "string") {
        challenge = data[1];
        void authenticate();
        return;
      }

      if (data[0] === "OK") {
        const [, id, ok, reason] = data as [string, string, boolean, string?];
        if (id === event.id) {
          if (ok) finish(true);
          // Auth challenges arrive in a separate AUTH frame; if we have one and
          // have not used it yet, authenticate and let the resend settle this.
          else if (isAuthRequired(reason) && !authAttempted) void authenticate();
          else if (!isAuthRequired(reason)) {
            rejection = reason || "rejected by relay";
            finish(false);
          }
          // else: auth in flight — wait for the resend result or the timeout.
        } else if (id === authEventId) {
          if (ok) sendEvent(); // authenticated: resend the mail event once
          else {
            rejection = reason || "auth rejected";
            finish(false);
          }
        }
      }
    });
    ws.on("error", (error) => {
      console.error(`nostr-bridge: relay ${relayUrl} error:`, (error as Error).message);
      finish(false);
    });
  });
}

/**
 * Wrap an inbound email for a recipient. The rumor content is the ORIGINAL
 * message, unmodified — headers are the identity and threading model (§1), so
 * reconstructing the message from parsed fields destroys both.
 */
export async function buildInboundWrap(
  raw: string,
  recipientPubkey: string,
  signer: ProtocolSigner,
  extraTags: string[][] = [],
): Promise<Event> {
  // Generate the wrap's ephemeral key first and pass the SAME key into the
  // rumor (as the deletable-mail WRAP_KEY_TAG) and the wrap itself — splitting
  // these would hand the recipient a deletion key that matches nothing.
  const ephemeralSk = generateSecretKey();
  const rumor = buildMailRumor({
    senderPubkey: await signer.getPublicKey(),
    recipientPubkey,
    rfc2822: raw,
    wrapSecret: ephemeralSk,
    extraTags,
  });
  return sealAndWrap(rumor, recipientPubkey, signer, { ephemeralSk });
}

/** Returns true if at least one relay accepted the event. */
export async function publishMail(params: {
  raw: string;
  recipientPubkey: string;
  signer: ProtocolSigner;
  relays: string[];
  extraTags?: string[][];
}): Promise<boolean> {
  const wrap = await buildInboundWrap(
    params.raw,
    params.recipientPubkey,
    params.signer,
    params.extraTags,
  );
  const relays = [...new Set(params.relays)];
  const results = await Promise.all(
    relays.map((relay) => publishToRelay(relay, wrap, params.signer)),
  );
  return results.some(Boolean);
}

export interface PreparedChunks {
  /** sha256 of the whole message — the reassembly key and integrity check. */
  msgid: string;
  totalBytes: number;
  /** How many parts the message split into (wraps is empty when over budget). */
  parts: number;
  wraps: Event[];
}

/**
 * Wrap a message that is too large for one gift wrap into ordered chunks.
 *
 * Each chunk is an independent kind-1059 with its own ephemeral key (so each
 * remains individually deletable via its `wrapkey` tag), carrying a byte range
 * of the original in its rumor. All tags live inside the rumor: putting
 * `chunk` on the wrap would tell relays how many parts a message has and let
 * them correlate the set, defeating NIP-59's ephemeral keys.
 *
 * Chunk sizing is done by `splitMessage` in encoded-JSON bytes, not raw bytes;
 * see the derivation in protocol/chunked-mail.ts.
 */
export async function buildInboundChunkWraps(params: {
  raw: string;
  recipientPubkey: string;
  signer: ProtocolSigner;
  /**
   * When set, skip wrapping entirely if the message needs more parts than
   * this. Building hundreds of wraps only to reject them is what the budget
   * check exists to avoid (each wrap is two NIP-44 encryptions).
   */
  maxChunks?: number;
  /** Extra rumor tags every chunk carries (e.g. inbound `imeta`). */
  extraTags?: string[][];
}): Promise<PreparedChunks> {
  const senderPubkey = await params.signer.getPublicKey();
  const { msgid, totalBytes, slices } = await splitMessage(params.raw, {
    senderPubkey,
    recipientPubkey: params.recipientPubkey,
    extraTags: params.extraTags,
  });

  if (params.maxChunks !== undefined && slices.length > params.maxChunks) {
    return { msgid, totalBytes, parts: slices.length, wraps: [] };
  }

  const wraps: Event[] = [];
  for (let i = 0; i < slices.length; i++) {
    const ephemeralSk = generateSecretKey();
    const rumor = buildMailRumor({
      senderPubkey,
      recipientPubkey: params.recipientPubkey,
      rfc2822: slices[i],
      wrapSecret: ephemeralSk,
      extraTags: [
        ...chunkTags(msgid, i, slices.length, totalBytes),
        ...(params.extraTags ?? []),
      ],
    });
    wraps.push(
      await sealAndWrap(rumor, params.recipientPubkey, params.signer, { ephemeralSk }),
    );
  }

  return { msgid, totalBytes, parts: slices.length, wraps };
}

/**
 * Chunked messages this process has already published, by msgid.
 *
 * Postfix retries whenever the LMTP 250 is lost (connection drop, a publish
 * that outlives the socket timeout, a bridge restart mid-response). Without
 * this, a retry re-wraps and re-publishes every part: more relay events, and a
 * recipient that mixes the two attempts sees different wrap ids for the same
 * slice. Re-ACKing a msgid we already published is the idempotent answer.
 *
 * In-memory on purpose: a restart loses it, but that is the rare case and the
 * fallback is the old behaviour (republish), not corruption.
 */
const PUBLISHED_TTL_MS = 60 * 60 * 1000;
const PUBLISHED_MAX = 500;
const recentlyPublished = new Map<string, number>();

function wasPublished(msgid: string): boolean {
  const at = recentlyPublished.get(msgid);
  if (at === undefined) return false;
  if (Date.now() - at > PUBLISHED_TTL_MS) {
    recentlyPublished.delete(msgid);
    return false;
  }
  return true;
}

function rememberPublished(msgid: string): void {
  recentlyPublished.set(msgid, Date.now());
  if (recentlyPublished.size <= PUBLISHED_MAX) return;
  const oldest = recentlyPublished.keys().next().value;
  if (oldest !== undefined) recentlyPublished.delete(oldest);
}

export type ChunkedPublishResult = {
  ok: boolean;
  parts: number;
  msgid?: string;
  /**
   * `too-many`: the split exceeds the configured part budget, so this message
   * cannot be delivered over Nostr at all (permanent). `failed`: at least one
   * chunk reached no relay (transient — the caller should let it retry).
   */
  reason?: "too-many" | "failed";
};

/**
 * Publish a chunked message, one chunk at a time, to every relay.
 *
 * Chunks are published sequentially with relays in parallel: a 15-part message
 * therefore opens at most 8 sockets at once rather than 120. (Batching all
 * chunks onto one connection per relay is a follow-up; `publishToRelay` opens
 * a socket per event today.)
 *
 * Success requires *every* chunk to be accepted by at least one relay. A
 * partially delivered set is unreadable, so it is reported as `failed` and the
 * caller returns LMTP 451, letting Postfix retry the message. The already-
 * accepted chunks are harmless duplicates: `msgid` (sha256 of the whole
 * message) lets the recipient collapse them.
 */
export async function publishChunkedMail(params: {
  raw: string;
  recipientPubkey: string;
  signer: ProtocolSigner;
  relays: string[];
  maxChunks?: number;
  /** Extra rumor tags every chunk carries (e.g. inbound `imeta`). */
  extraTags?: string[][];
}): Promise<ChunkedPublishResult> {
  const maxChunks = params.maxChunks ?? 64;
  const prepared = await buildInboundChunkWraps({ ...params, maxChunks });

  if (prepared.wraps.length === 0) {
    return {
      ok: false,
      parts: prepared.parts,
      msgid: prepared.msgid,
      reason: "too-many",
    };
  }

  // A retry after a lost LMTP response must not re-publish the whole set.
  if (wasPublished(prepared.msgid)) {
    console.warn(
      `nostr-bridge: msgid ${prepared.msgid.slice(0, 12)} already published; ` +
        "re-ACKing without re-publishing",
    );
    return { ok: true, parts: prepared.parts, msgid: prepared.msgid };
  }

  const relays = [...new Set(params.relays)];
  const publish = (wrap: Event) =>
    Promise.all(relays.map((relay) => publishToRelay(relay, wrap, params.signer))).then(
      (results) => results.some(Boolean),
    );

  // Publishing used to be strictly sequential: a 38-part message spent 60 s+
  // in relay round-trips and the LMTP client gave up (Postfix 421, then a
  // retry). Four parts in flight keeps a 64-part message well inside the socket
  // timeout without opening scores of sockets at once.
  const CHUNK_CONCURRENCY = 4;
  let cursor = 0;
  let failed = false;

  const worker = async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= prepared.wraps.length) return;
      const wrap = prepared.wraps[index];
      // One retry per chunk: a single relay timeout should not cost the whole
      // message a 451 and a full duplicate resend.
      if (!(await publish(wrap)) && !(await publish(wrap))) {
        failed = true;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(CHUNK_CONCURRENCY, prepared.wraps.length) },
      () => worker(),
    ),
  );

  if (failed) {
    return {
      ok: false,
      parts: prepared.parts,
      msgid: prepared.msgid,
      reason: "failed",
    };
  }

  rememberPublished(prepared.msgid);
  return { ok: true, parts: prepared.parts, msgid: prepared.msgid };
}
