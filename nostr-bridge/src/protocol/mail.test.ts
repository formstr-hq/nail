import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, getEventHash, finalizeEvent } from "nostr-tools/pure";
import { getConversationKey, encrypt } from "nostr-tools/nip44";
import { keySigner } from "./key-signer.js";
import { buildMailRumor, sealAndWrap, unwrapAndVerify, deliverTargets } from "./mail.js";
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
});
