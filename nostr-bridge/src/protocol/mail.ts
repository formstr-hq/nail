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

export function buildMailRumor(params: {
  senderPubkey: string;
  recipientPubkey: string;
  rfc2822: string;
  deliverTo?: string[];
}): Rumor {
  const tags: string[][] = [["p", params.recipientPubkey]];
  for (const address of params.deliverTo ?? []) tags.push(["deliver", address]);

  const rumor = {
    kind: KIND_MAIL,
    pubkey: params.senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: params.rfc2822,
  };
  return { ...rumor, id: getEventHash(rumor) };
}

/** Structural check for the six fields `Rumor` requires (types.ts). A rumor
 * that fails this can't be trusted downstream: `deliverTargets` assumes
 * `tags` is an array, and the staleness check assumes `created_at` is a
 * number — either missing turns into an uncaught crash or a silently
 * bypassed replay check (`now - undefined` is `NaN`, and `NaN > maxAge` is
 * always false). */
function isValidRumorShape(value: unknown): value is Rumor {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.kind === "number" &&
    typeof r.pubkey === "string" &&
    typeof r.created_at === "number" &&
    Array.isArray(r.tags) &&
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
      kind: KIND_GIFTWRAP,
      created_at: randomPast(now),
      tags: [["p", recipientPubkey]],
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
  opts: { maxAgeSeconds?: number; now?: number } = {},
): Promise<UnwrapResult> {
  const maxAge = opts.maxAgeSeconds ?? MAX_RUMOR_AGE_SECONDS;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

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

  if (typeof seal?.kind !== "number" || typeof seal?.pubkey !== "string") {
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

  if (rumor.kind !== KIND_MAIL) return { ok: false, reason: "wrong-rumor-kind" };
  if (now - rumor.created_at > maxAge) return { ok: false, reason: "expired" };

  return { ok: true, seal, rumor };
}
