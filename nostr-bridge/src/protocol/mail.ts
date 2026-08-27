import { generateSecretKey, getEventHash, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { getConversationKey, encrypt } from "nostr-tools/nip44";
import type { Event } from "nostr-tools";
import { KIND_MAIL, KIND_SEAL, KIND_GIFTWRAP, MAX_RUMOR_AGE_SECONDS } from "./constants.js";
import type { ProtocolSigner, Rumor, UnwrapResult } from "./types.js";

const TWO_DAYS = 2 * 24 * 60 * 60;

/** NIP-59: outer timestamps are randomized into the past to thwart time analysis. */
function randomPast(now: number): number {
  return now - Math.floor(Math.random() * TWO_DAYS);
}

/**
 * Build any rumor (unsigned inner event) with a computed id. `p` is always the
 * first tag — it names the recipient the seal is encrypted to. Callers add
 * kind-specific tags via `extraTags` (mail's `deliver` targets, a health ping's
 * `nonce`, …). The id is `getEventHash` over the same shape nostr-tools uses, so
 * `unwrapAndVerify`'s shape and author checks hold on the far side.
 */
export function buildRumor(params: {
  senderPubkey: string;
  recipientPubkey: string;
  kind: number;
  content: string;
  extraTags?: string[][];
}): Rumor {
  const rumor = {
    kind: params.kind,
    pubkey: params.senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", params.recipientPubkey], ...(params.extraTags ?? [])],
    content: params.content,
  };
  return { ...rumor, id: getEventHash(rumor) };
}

export function buildMailRumor(params: {
  senderPubkey: string;
  recipientPubkey: string;
  rfc2822: string;
  deliverTo?: string[];
}): Rumor {
  return buildRumor({
    senderPubkey: params.senderPubkey,
    recipientPubkey: params.recipientPubkey,
    kind: KIND_MAIL,
    content: params.rfc2822,
    extraTags: (params.deliverTo ?? []).map((address) => ["deliver", address]),
  });
}

/** Structural check for the six fields `Rumor` requires (types.ts). A rumor
 * that fails this can't be trusted downstream: `deliverTargets` assumes
 * `tags` is an array of string arrays, and the staleness check assumes
 * `created_at` is a number — any of these being wrong turns into an
 * uncaught crash (e.g. `null[0]` in `deliverTargets`) or a silently
 * bypassed replay check (`now - undefined` is `NaN`, and `NaN > maxAge` is
 * always false). Mirrors nostr-tools' own `validateEvent` tag check. */
function isValidRumorShape(value: unknown): value is Rumor {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.kind === "number" &&
    typeof r.pubkey === "string" &&
    typeof r.created_at === "number" &&
    Array.isArray(r.tags) &&
    r.tags.every((tag) => Array.isArray(tag) && tag.every((el) => typeof el === "string")) &&
    typeof r.content === "string"
  );
}

/** The envelope for this hop — who the bridge must deliver to (§4). */
export function deliverTargets(rumor: Rumor): string[] {
  return rumor.tags.filter((t) => t[0] === "deliver" && t[1]).map((t) => t[1]);
}

export async function sealAndWrap(
  rumor: Rumor,
  recipientPubkey: string,
  signer: ProtocolSigner,
  opts: { wrapKind?: number } = {},
): Promise<Event> {
  const now = Math.floor(Date.now() / 1000);

  const seal = await signer.signEvent({
    kind: KIND_SEAL,
    pubkey: await signer.getPublicKey(),
    created_at: randomPast(now),
    tags: [],
    content: await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor)),
  });

  const ephemeralSk = generateSecretKey();
  return finalizeEvent(
    {
      // Mail uses the standard, persisted gift-wrap kind; transient control
      // traffic (receipts, health pings) passes `wrapKind: KIND_GIFTWRAP_EPHEMERAL`
      // so relays broadcast without storing it. The inner rumor kind is unchanged.
      kind: opts.wrapKind ?? KIND_GIFTWRAP,
      created_at: randomPast(now),
      // `p` routes the wrap; `k` marks the *inner* kind so a recipient can tell
      // mailstr mail (1301) from other NIP-59 gift-wraps (e.g. NIP-17 DMs, also
      // kind 1059) WITHOUT unwrapping — which is what lets the background
      // notifier filter mail-only (`#k`) instead of pinging on every DM. The
      // only thing this leaks to a relay observer is "this wrap is mail", and
      // the address↔npub link is already public via NIP-05; sender, content
      // and true timing stay hidden.
      tags: [["p", recipientPubkey], ["k", String(rumor.kind)]],
      content: encrypt(
        JSON.stringify(seal),
        getConversationKey(ephemeralSk, recipientPubkey),
      ),
    },
    ephemeralSk,
  );
}

/**
 * Unwrap a gift wrap and apply verification rules 1-4 from §4.
 *
 * Deliberately does NOT use nostr-tools' unwrapEvent: that helper discards the
 * seal and never checks rumor.pubkey against seal.pubkey, which makes sender
 * spoofing trivial for anything that authorizes on the rumor (§5).
 */
export async function unwrapAndVerify(
  wrap: Event,
  signer: ProtocolSigner,
  opts: { maxAgeSeconds?: number; now?: number; acceptKinds?: number[] } = {},
): Promise<UnwrapResult> {
  const maxAge = opts.maxAgeSeconds ?? MAX_RUMOR_AGE_SECONDS;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  // Rule 4 (§4): which inner kinds this caller is willing to accept. Defaults to
  // mail only, so existing callers are unchanged; the bridge additionally accepts
  // its health-ping loopback and the client accepts delivery receipts. Anything
  // outside the set is still rejected as wrong-rumor-kind.
  const acceptKinds = opts.acceptKinds ?? [KIND_MAIL];

  // Failure here is routine: relays hand us every wrap p-tagged to us, and
  // most are not ours to decrypt.
  let sealPlaintext: string;
  try {
    sealPlaintext = await signer.nip44Decrypt(wrap.pubkey, wrap.content);
  } catch {
    return { ok: false, reason: "not-for-us" };
  }

  // Decryption succeeded, so this wrap genuinely was addressed to us — a
  // non-JSON or malformed result past this point is broken/hostile input,
  // not routine traffic, and must be reported rather than swallowed.
  let seal: Event;
  try {
    const parsed: unknown = JSON.parse(sealPlaintext);
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, reason: "malformed-seal" };
    }
    seal = parsed as Event;
  } catch {
    return { ok: false, reason: "malformed-seal" };
  }

  if (typeof seal.kind !== "number" || typeof seal.pubkey !== "string") {
    return { ok: false, reason: "malformed-seal" };
  }
  // Rules in spec order: (1) signature, (2) seal.kind, (3) author match,
  // (4) rumor.kind, (5) staleness.
  if (!verifyEvent(seal)) return { ok: false, reason: "bad-seal-signature" };
  if (seal.kind !== KIND_SEAL) return { ok: false, reason: "wrong-seal-kind" };

  let rumor: Rumor;
  try {
    const parsed: unknown = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content));
    if (!isValidRumorShape(parsed)) {
      return { ok: false, reason: "malformed-rumor" };
    }
    rumor = parsed;
  } catch {
    return { ok: false, reason: "malformed-rumor" };
  }

  // Rule 3 — the one nostr-tools omits. Everything downstream authorizes on
  // seal.pubkey, so a rumor claiming a different author is hostile.
  if (rumor.pubkey !== seal.pubkey) return { ok: false, reason: "author-mismatch" };

  if (!acceptKinds.includes(rumor.kind)) return { ok: false, reason: "wrong-rumor-kind" };
  if (now - rumor.created_at > maxAge) return { ok: false, reason: "expired" };

  return { ok: true, seal, rumor };
}
