import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, getEventHash, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { getConversationKey, encrypt } from "nostr-tools/nip44";
import { hexToBytes } from "nostr-tools/utils";
import { keySigner } from "./key-signer.js";
import { buildMailRumor, sealAndWrap, unwrapAndVerify, deliverTargets, WRAP_KEY_TAG } from "./mail.js";
import { KIND_MAIL, KIND_GIFTWRAP } from "./constants.js";

const RFC = "From: a@mailstr.app\r\nTo: b@gmail.com\r\nSubject: hi\r\n\r\nbody";

function actor() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), signer: keySigner(sk) };
}

describe("buildMailRumor", () => {
  it("produces a kind-1301 rumor with a p tag and an id", () => {
    const alice = actor(), bob = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk,
      recipientPubkey: bob.pk,
      rfc2822: RFC,
    });
    expect(rumor.kind).toBe(KIND_MAIL);
    expect(rumor.pubkey).toBe(alice.pk);
    expect(rumor.content).toBe(RFC);
    expect(rumor.tags).toContainEqual(["p", bob.pk]);
    expect(rumor.id).toHaveLength(64);
  });

  it("writes one deliver tag per legacy recipient", () => {
    const alice = actor(), bridge = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk,
      recipientPubkey: bridge.pk,
      rfc2822: RFC,
      deliverTo: ["b@gmail.com", "c@yahoo.com"],
    });
    expect(deliverTargets(rumor)).toEqual(["b@gmail.com", "c@yahoo.com"]);
  });

  it("has no deliver tags when none are given", () => {
    const alice = actor(), bob = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk,
      recipientPubkey: bob.pk,
      rfc2822: RFC,
    });
    expect(deliverTargets(rumor)).toEqual([]);
  });
});

describe("round trip", () => {
  it("wraps as kind 1059 p-tagged to the recipient", async () => {
    const alice = actor(), bob = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });
    const wrap = await sealAndWrap(rumor, bob.pk, alice.signer);
    expect(wrap.kind).toBe(KIND_GIFTWRAP);
    expect(wrap.tags).toContainEqual(["p", bob.pk]);
    // `k` exposes the inner kind so mail can be told from other 1059s (DMs)
    // without unwrapping — the background notifier filters on this.
    expect(wrap.tags).toContainEqual(["k", String(KIND_MAIL)]);
    expect(wrap.pubkey).not.toBe(alice.pk); // ephemeral
  });

  it("the recipient recovers the rumor and the true sender", async () => {
    const alice = actor(), bob = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });
    const wrap = await sealAndWrap(rumor, bob.pk, alice.signer);

    const result = await unwrapAndVerify(wrap, bob.signer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seal.pubkey).toBe(alice.pk);
    expect(result.rumor.content).toBe(RFC);
  });

  it("a third party cannot decrypt it", async () => {
    const alice = actor(), bob = actor(), eve = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });
    const wrap = await sealAndWrap(rumor, bob.pk, alice.signer);

    const result = await unwrapAndVerify(wrap, eve.signer);
    expect(result).toEqual({ ok: false, reason: "not-for-us" });
  });
});

describe("wrapkey — the deletable-mail tag", () => {
  it("is absent when no wrap secret is given (legacy wrapping)", async () => {
    const alice = actor(), bob = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });
    expect(rumor.tags.some((t) => t[0] === WRAP_KEY_TAG)).toBe(false);

    const wrap = await sealAndWrap(rumor, bob.pk, alice.signer);
    const result = await unwrapAndVerify(wrap, bob.signer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wrapSecret).toBeUndefined();
  });

  it("commits the ephemeral key to the rumor id and returns it on unwrap", async () => {
    const alice = actor(), bob = actor();
    const ephemeralSk = generateSecretKey();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
      wrapSecret: ephemeralSk,
    });

    // The tag must be committed to by the rumor's id: otherwise the sender
    // could swap the embedded key without invalidating anything.
    const bare = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });
    expect(rumor.id).not.toBe(bare.id);

    const wrap = await sealAndWrap(rumor, bob.pk, alice.signer, ephemeralSk);
    expect(wrap.pubkey).toBe(getPublicKey(ephemeralSk));

    const result = await unwrapAndVerify(wrap, bob.signer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wrapSecret).toBeDefined();

    // The returned key authors a NIP-09 kind-5 that relays must honor: its
    // pubkey IS the wrap's author, so the author-match rule cannot reject it.
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["e", wrap.id], ["k", String(KIND_GIFTWRAP)]],
        content: "",
      },
      hexToBytes(result.wrapSecret!),
    );
    expect(deletion.pubkey).toBe(wrap.pubkey);
    expect(verifyEvent(deletion)).toBe(true);
    expect(deletion.tags).toContainEqual(["e", wrap.id]);
  });

  it("rejects a rumor embedding a key that does not sign the wrap", async () => {
    const alice = actor(), bob = actor();
    // Mallory embeds HER key but the wrap is signed by a different ephemeral
    // key — deletions authored from the rumor would silently fail at relays.
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
      wrapSecret: generateSecretKey(),
    });
    const wrap = await sealAndWrap(rumor, bob.pk, alice.signer, generateSecretKey());

    const result = await unwrapAndVerify(wrap, bob.signer);
    expect(result).toEqual({ ok: false, reason: "wrapkey-mismatch" });
  });

  it("rejects a wrapkey that is not a parseable secret at all", async () => {
    const alice = actor(), bob = actor();
    const rumor: any = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });
    rumor.tags.push([WRAP_KEY_TAG, "not-hex-not-a-key"]);
    rumor.id = getEventHash(rumor);

    const wrap = await sealAndWrap(rumor, bob.pk, alice.signer);
    const result = await unwrapAndVerify(wrap, bob.signer);
    expect(result).toEqual({ ok: false, reason: "wrapkey-mismatch" });
  });
});

describe("verification rules", () => {
  // §5. The attacker seals with a key they genuinely hold, but sets
  // rumor.pubkey to the victim's. Code that authorizes on rumor.pubkey
  // would send mail as the victim.
  it("rejects a rumor whose author does not match the seal", async () => {
    const alice = actor(), bridge = actor(), mallory = actor();

    const forged: any = {
      kind: KIND_MAIL,
      pubkey: alice.pk, // the lie
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", bridge.pk]],
      content: "From: alice@mailstr.app\r\nTo: v@gmail.com\r\n\r\nsend money",
    };
    forged.id = getEventHash(forged);

    const wrap = await sealAndWrap(forged, bridge.pk, mallory.signer);
    const result = await unwrapAndVerify(wrap, bridge.signer);

    expect(result).toEqual({ ok: false, reason: "author-mismatch" });
  });

  it("rejects a non-1301 rumor", async () => {
    const alice = actor(), bob = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });
    const chat: any = { ...rumor, kind: 14 };
    chat.id = getEventHash(chat);

    const wrap = await sealAndWrap(chat, bob.pk, alice.signer);
    const result = await unwrapAndVerify(wrap, bob.signer);

    expect(result).toEqual({ ok: false, reason: "wrong-rumor-kind" });
  });

  it("rejects a stale rumor as a replay", async () => {
    const alice = actor(), bob = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });
    const wrap = await sealAndWrap(rumor, bob.pk, alice.signer);

    const result = await unwrapAndVerify(wrap, bob.signer, {
      now: rumor.created_at + 3600,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a seal that is not kind 13", async () => {
    const alice = actor(), bob = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });

    // Hand-build a wrap whose inner event is kind 1 rather than a seal.
    const notASeal = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: await alice.signer.nip44Encrypt(bob.pk, JSON.stringify(rumor)),
      },
      alice.sk,
    );
    const ek = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFTWRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", bob.pk]],
        content: encrypt(JSON.stringify(notASeal), getConversationKey(ek, bob.pk)),
      },
      ek,
    );

    const result = await unwrapAndVerify(wrap, bob.signer);
    expect(result).toEqual({ ok: false, reason: "wrong-seal-kind" });
  });

  it("rejects a seal with a tampered signature", async () => {
    const alice = actor(), bob = actor();
    const rumor = buildMailRumor({
      senderPubkey: alice.pk, recipientPubkey: bob.pk, rfc2822: RFC,
    });

    const seal = finalizeEvent(
      {
        kind: 13,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: await alice.signer.nip44Encrypt(bob.pk, JSON.stringify(rumor)),
      },
      alice.sk,
    );
    const tampered = { ...seal, sig: "0".repeat(128) };

    const ek = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFTWRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", bob.pk]],
        content: encrypt(JSON.stringify(tampered), getConversationKey(ek, bob.pk)),
      },
      ek,
    );

    const result = await unwrapAndVerify(wrap, bob.signer);
    expect(result).toEqual({ ok: false, reason: "bad-seal-signature" });
  });

  // Finding 1: a rumor missing tags/created_at/id, sealed with the
  // attacker's own key so rumor.pubkey === seal.pubkey (author check
  // passes legitimately). If the shape isn't fully validated, `now -
  // undefined` is NaN, the staleness comparison silently never fires, and
  // the caller gets ok:true with a rumor whose .tags is undefined — a
  // guaranteed crash in deliverTargets().
  it("rejects a rumor missing required fields even when self-authored", async () => {
    const mallory = actor(), bridge = actor();

    const forged: any = {
      kind: KIND_MAIL,
      pubkey: mallory.pk,
      content: "x",
      // tags, created_at, id deliberately omitted
    };

    const wrap = await sealAndWrap(forged, bridge.pk, mallory.signer);
    const result = await unwrapAndVerify(wrap, bridge.signer);

    expect(result).toEqual({ ok: false, reason: "malformed-rumor" });
  });

  // Finding 2: the outer decrypt genuinely succeeds (it's addressed to us)
  // but the plaintext isn't JSON. That's a broken/hostile seal, not routine
  // "not for us" traffic, and must be reported so callers don't silently
  // swallow it.
  it("reports a non-JSON seal plaintext as malformed-seal, not not-for-us", async () => {
    const bob = actor();

    const ek = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFTWRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", bob.pk]],
        content: encrypt("not json at all", getConversationKey(ek, bob.pk)),
      },
      ek,
    );

    const result = await unwrapAndVerify(wrap, bob.signer);
    expect(result).toEqual({ ok: false, reason: "malformed-seal" });
  });

  // Finding (residual): tags is present (Array.isArray passes) but an
  // element is malformed. Sealed with the attacker's OWN key so
  // rumor.pubkey === seal.pubkey and the author-match rule genuinely
  // passes rather than being what rejects the input. If tags elements
  // aren't validated, this reaches ok:true and `deliverTargets` crashes
  // on `null[0]`.
  it("rejects a rumor whose tags contain a malformed element", async () => {
    const mallory = actor(), bridge = actor();

    // getEventHash refuses to serialize a malformed-tags event (it runs the
    // same shape check we're fixing), so the id can't come from it here —
    // any string satisfies isValidRumorShape's `typeof id === "string"`.
    const forged: any = {
      id: "a".repeat(64),
      kind: KIND_MAIL,
      pubkey: mallory.pk,
      created_at: Math.floor(Date.now() / 1000),
      tags: [null],
      content: "x",
    };

    const wrap = await sealAndWrap(forged, bridge.pk, mallory.signer);
    const result = await unwrapAndVerify(wrap, bridge.signer);

    expect(result).toEqual({ ok: false, reason: "malformed-rumor" });
  });
});
