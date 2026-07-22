# mailstr Protocol Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mail flow end to end in both directions between the mailstr client and the Nostr bridge, on one shared, verified wire protocol.

**Architecture:** A single protocol module in `nostr-bridge/src/protocol/` owns rumor construction, sealing, wrapping, unwrapping, and all verification rules. The bridge, the client, and the e2e suite all import it — replacing three divergent implementations. The bridge is rewritten to speak kind 1301 with raw RFC 2822 in both directions and to authorize senders against `seal.pubkey`. The client gains the kind-13 seal it never had.

**Tech Stack:** TypeScript, `nostr-tools` ^2.x, vitest, React 18 + Vite (client), Node 24 + smtp-server/nodemailer (bridge).

**Spec:** [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md). Section references below (§4, §5, …) point there.

## Global Constraints

- The protocol module must use **no Node built-ins** — no `node:crypto`, no `Buffer`. Web Crypto and `Uint8Array` only, `nostr-tools` as the sole dependency. It is bundled into the browser by Vite.
- The protocol module's internal imports must carry **`.js` extensions**. `nostr-bridge/tsconfig.json` uses `moduleResolution: NodeNext`, which requires them; the client's `bundler` resolution tolerates them.
- **pnpm only.** Never run `npm install`.
- Authorization is always against **`seal.pubkey`**, never `rumor.pubkey`. See §5.
- **`unwrapEvent` from `nostr-tools/nip59` must never be used.** It discards the seal and skips the author check.
- Kind numbers are fixed: mail rumor `1301`, seal `13`, gift wrap `1059`, DM relay list `10050`, profile `0`.
- Per-app verification, run from that app's directory:
  `pnpm install && npx tsc --noEmit -p tsconfig.app.json && npx vite build` (client)
  `pnpm install && npx tsc -p tsconfig.json` (bridge)

---

## File Structure

**Create — protocol module** (`nostr-bridge/src/protocol/`, imported by all three consumers):

| File | Responsibility |
|---|---|
| `constants.ts` | Kind numbers, size and age limits. |
| `types.ts` | `Rumor`, `ProtocolSigner`, `UnwrapResult`, `UnwrapFailure`. |
| `address.ts` | Address parsing and normalization (lowercase, strip `+tag`), npub/hex detection. |
| `key-signer.ts` | `ProtocolSigner` backed by a raw secret key. Used by the bridge and by tests. |
| `mail.ts` | `buildMailRumor`, `sealAndWrap`, `unwrapAndVerify`. The verification rules live here. |
| `index.ts` | Re-exports. |

**Modify — bridge:**

| File | Change |
|---|---|
| `src/nostr-listener.ts` | Rewrite outbound: `unwrapAndVerify`, authorize on `seal.pubkey`, `deliver` tags, replay guard. |
| `src/nostr-publisher.ts` | Rewrite inbound: kind 1301, raw RFC 2822, kind-10050 relays. |
| `src/lmtp-server.ts` | 550 vs 451 distinction; pass raw bytes through. |
| `src/user-resolver.ts` | Query kind 10050, not 10002. |
| `src/nip05.ts` | Use `normalizeLocalpart`; distinguish "not found" from "lookup failed". |
| `src/config.ts` | Add `localDomains`, `bridgeRelays`. |
| `src/index.ts` | Call bridge self-publication on boot. |

**Delete:** `nostr-bridge/src/key-derivation.ts` (the per-recipient pseudonym scheme, §Known-broken 3).

**Modify — client:**

| File | Change |
|---|---|
| `src/lib/nostr/protocol-signer.ts` | **Create.** Adapts `@formstr/signer`'s `ActiveSigner` to `ProtocolSigner`. |
| `src/lib/nostr/giftwrap.ts` | Strip to npub/hex helpers; wrapping moves to the protocol module. |
| `src/lib/mail/resolve.ts` | Rewrite to the §7 algorithm. |
| `src/lib/mail/send.ts` | Group recipients; one bridge wrap with `deliver` tags. |
| `src/lib/mail/receive.ts` | Use `unwrapAndVerify`; apply trust rule 5. |
| `src/lib/nostr/nip05.ts` | Add the bounded, cached probe. Delete `isLegacyEmail`, `resolveBridgePubkey`. |
| `src/lib/nostr/bridge.ts` | **Create.** Bridge discovery: `_smtp@<own domain>` with Settings override. |

**Modify — e2e:** `src/nostr-helper.ts` loses its wrap builder; tests import the protocol module.

---

### Task 1: Protocol module foundations

Test tooling, constants, types, address normalization, and the raw-key signer. Nothing here does crypto layering yet — that is Task 2.

**Files:**
- Create: `nostr-bridge/src/protocol/constants.ts`, `types.ts`, `address.ts`, `key-signer.ts`, `index.ts`
- Create: `nostr-bridge/vitest.config.ts`
- Create: `nostr-bridge/src/protocol/address.test.ts`
- Modify: `nostr-bridge/package.json` (add vitest, `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `KIND_MAIL`, `KIND_SEAL`, `KIND_GIFTWRAP`, `KIND_DM_RELAYS`, `KIND_PROFILE`, `MAX_RUMOR_AGE_SECONDS`; types `Rumor`, `ProtocolSigner`, `UnwrapResult`, `UnwrapFailure`; `normalizeLocalpart(address: string): string`, `splitAddress(address: string): {localpart: string; domain: string} | null`, `isNpub(v: string): boolean`, `isHexPubkey(v: string): boolean`; `keySigner(secretKey: Uint8Array): ProtocolSigner`.

- [ ] **Step 1: Add vitest to the bridge**

```bash
cd nostr-bridge && pnpm add -D vitest@^3.0.0
```

Then add to `nostr-bridge/package.json` `scripts`:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

Create `nostr-bridge/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 2: Write the failing address test**

Create `nostr-bridge/src/protocol/address.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeLocalpart, splitAddress, isNpub, isHexPubkey } from "./address.js";

describe("normalizeLocalpart", () => {
  it("lowercases the localpart", () => {
    expect(normalizeLocalpart("Xyz@mailstr.app")).toBe("xyz");
  });

  it("strips plus-addressing", () => {
    expect(normalizeLocalpart("xyz+newsletter@mailstr.app")).toBe("xyz");
  });

  it("lowercases and strips together", () => {
    expect(normalizeLocalpart("Xyz+News@mailstr.app")).toBe("xyz");
  });

  it("returns the whole string when there is no @", () => {
    expect(normalizeLocalpart("xyz")).toBe("xyz");
  });
});

describe("splitAddress", () => {
  it("splits and lowercases the domain", () => {
    expect(splitAddress("Alice@Mailstr.App")).toEqual({
      localpart: "alice",
      domain: "mailstr.app",
    });
  });

  it("returns null with no @", () => {
    expect(splitAddress("alice")).toBeNull();
  });

  it("returns null with an empty localpart", () => {
    expect(splitAddress("@mailstr.app")).toBeNull();
  });
});

describe("isNpub / isHexPubkey", () => {
  it("accepts a 63-char npub", () => {
    expect(isNpub("npub1" + "q".repeat(58))).toBe(true);
  });

  it("rejects a short npub", () => {
    expect(isNpub("npub1abc")).toBe(false);
  });

  it("accepts 64 lowercase hex chars", () => {
    expect(isHexPubkey("a".repeat(64))).toBe(true);
  });

  it("rejects uppercase hex", () => {
    expect(isHexPubkey("A".repeat(64))).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd nostr-bridge && pnpm test`
Expected: FAIL — `Failed to resolve import "./address.js"`.

- [ ] **Step 4: Write constants and types**

Create `nostr-bridge/src/protocol/constants.ts`:

```ts
export const KIND_MAIL = 1301;
export const KIND_SEAL = 13;
export const KIND_GIFTWRAP = 1059;
export const KIND_DM_RELAYS = 10050;
export const KIND_PROFILE = 0;

/** Rumors older than this are rejected as replays (§6B step 7). */
export const MAX_RUMOR_AGE_SECONDS = 300;

/** NIP-44 v2 plaintext ceiling. Content above this cannot be encrypted at all. */
export const MAX_PLAINTEXT_BYTES = 65535;
```

Create `nostr-bridge/src/protocol/types.ts`:

```ts
import type { Event, UnsignedEvent } from "nostr-tools";

/** An unsigned nostr event. `id` is set; `sig` is deliberately absent. */
export interface Rumor {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * The key operations the protocol needs, abstracted so the browser can back
 * them with NIP-07/NIP-46 and the bridge with a raw secret key.
 */
export interface ProtocolSigner {
  getPublicKey(): Promise<string>;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<Event>;
}

/**
 * Why an unwrap failed. `not-for-us` is routine — relays deliver every wrap
 * p-tagged to us, including ones we cannot decrypt. Every other value means
 * something is broken or hostile and MUST be logged and counted (§8).
 */
export type UnwrapFailure =
  | "not-for-us"
  | "malformed-seal"
  | "bad-seal-signature"
  | "wrong-seal-kind"
  | "malformed-rumor"
  | "author-mismatch"
  | "wrong-rumor-kind"
  | "expired";

export type UnwrapResult =
  | { ok: true; seal: Event; rumor: Rumor }
  | { ok: false; reason: UnwrapFailure };
```

- [ ] **Step 5: Write the address helpers**

Create `nostr-bridge/src/protocol/address.ts`:

```ts
/**
 * The mailbox name an address authorizes against. SMTP treats `Xyz@` and
 * `xyz@` as one mailbox and `xyz+tag@` as a subaddress of `xyz`, but NIP-05
 * lookup is an exact string match — so both must be normalized away before
 * the record is fetched (§3).
 */
export function normalizeLocalpart(address: string): string {
  const at = address.indexOf("@");
  const local = at > 0 ? address.slice(0, at) : address;
  const plus = local.indexOf("+");
  return (plus > 0 ? local.slice(0, plus) : local).toLowerCase();
}

export function splitAddress(
  address: string,
): { localpart: string; domain: string } | null {
  const at = address.indexOf("@");
  if (at < 1) return null;
  const domain = address.slice(at + 1).toLowerCase();
  if (!domain) return null;
  return { localpart: normalizeLocalpart(address), domain };
}

export function isNpub(value: string): boolean {
  return value.startsWith("npub1") && value.length === 63;
}

export function isHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
```

- [ ] **Step 6: Run the address tests**

Run: `cd nostr-bridge && pnpm test`
Expected: PASS — 11 tests.

- [ ] **Step 7: Write the raw-key signer**

Create `nostr-bridge/src/protocol/key-signer.ts`:

```ts
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";
import type { Event, UnsignedEvent } from "nostr-tools";
import type { ProtocolSigner } from "./types.js";

/**
 * A ProtocolSigner backed by a secret key held in memory. Used by the bridge
 * (which owns its key outright) and by tests. The browser uses an
 * @formstr/signer-backed implementation instead — the user's key never
 * reaches application code there.
 */
export function keySigner(secretKey: Uint8Array): ProtocolSigner {
  const pubkey = getPublicKey(secretKey);
  return {
    async getPublicKey() {
      return pubkey;
    },
    async nip44Encrypt(peerPubkey: string, plaintext: string) {
      return encrypt(plaintext, getConversationKey(secretKey, peerPubkey));
    },
    async nip44Decrypt(peerPubkey: string, ciphertext: string) {
      return decrypt(ciphertext, getConversationKey(secretKey, peerPubkey));
    },
    async signEvent(event: UnsignedEvent): Promise<Event> {
      return finalizeEvent(event, secretKey);
    },
  };
}
```

Create `nostr-bridge/src/protocol/index.ts`:

```ts
export * from "./constants.js";
export * from "./types.js";
export * from "./address.js";
export * from "./key-signer.js";
```

- [ ] **Step 8: Verify the bridge still typechecks**

Run: `cd nostr-bridge && npx tsc -p tsconfig.json`
Expected: no output (success).

- [ ] **Step 9: Commit**

```bash
git add nostr-bridge/src/protocol nostr-bridge/vitest.config.ts nostr-bridge/package.json nostr-bridge/pnpm-lock.yaml
git commit -m "Add protocol module foundations: constants, types, address helpers"
```

---

### Task 2: Seal, wrap, and the verification rules

The security core. `unwrapAndVerify` implements §4's five rules; the spoofing test from §5 is the gate.

**Files:**
- Create: `nostr-bridge/src/protocol/mail.ts`, `nostr-bridge/src/protocol/mail.test.ts`
- Modify: `nostr-bridge/src/protocol/index.ts`

**Interfaces:**
- Consumes: `Rumor`, `ProtocolSigner`, `UnwrapResult` and the kind constants from Task 1; `keySigner`.
- Produces:
  - `buildMailRumor(params: { senderPubkey: string; recipientPubkey: string; rfc2822: string; deliverTo?: string[] }): Rumor`
  - `sealAndWrap(rumor: Rumor, recipientPubkey: string, signer: ProtocolSigner): Promise<Event>`
  - `unwrapAndVerify(wrap: Event, signer: ProtocolSigner, opts?: { maxAgeSeconds?: number; now?: number }): Promise<UnwrapResult>`
  - `deliverTargets(rumor: Rumor): string[]`

- [ ] **Step 1: Write the failing tests**

Create `nostr-bridge/src/protocol/mail.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd nostr-bridge && pnpm test`
Expected: FAIL — `Failed to resolve import "./mail.js"`.

- [ ] **Step 3: Implement `mail.ts`**

Create `nostr-bridge/src/protocol/mail.ts`:

```ts
import { generateSecretKey, getPublicKey, getEventHash, finalizeEvent, verifyEvent } from "nostr-tools/pure";
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
  return { ...rumor, id: getEventHash(rumor as never) };
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
      pubkey: getPublicKey(ephemeralSk),
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

  // Failure here is routine: relays hand us every wrap p-tagged to us.
  let seal: Event;
  try {
    seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content));
  } catch {
    return { ok: false, reason: "not-for-us" };
  }

  if (typeof seal?.kind !== "number" || typeof seal?.pubkey !== "string") {
    return { ok: false, reason: "malformed-seal" };
  }
  if (seal.kind !== KIND_SEAL) return { ok: false, reason: "wrong-seal-kind" };
  if (!verifyEvent(seal)) return { ok: false, reason: "bad-seal-signature" };

  let rumor: Rumor;
  try {
    rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content));
  } catch {
    return { ok: false, reason: "malformed-rumor" };
  }

  if (typeof rumor?.pubkey !== "string" || typeof rumor?.kind !== "number") {
    return { ok: false, reason: "malformed-rumor" };
  }

  // Rule 3 — the one nostr-tools omits. Everything downstream authorizes on
  // seal.pubkey, so a rumor claiming a different author is hostile.
  if (rumor.pubkey !== seal.pubkey) return { ok: false, reason: "author-mismatch" };

  if (rumor.kind !== KIND_MAIL) return { ok: false, reason: "wrong-rumor-kind" };
  if (now - rumor.created_at > maxAge) return { ok: false, reason: "expired" };

  return { ok: true, seal, rumor };
}
```

Add to `nostr-bridge/src/protocol/index.ts`:

```ts
export * from "./mail.js";
```

- [ ] **Step 4: Run the tests**

Run: `cd nostr-bridge && pnpm test`
Expected: PASS — all of `mail.test.ts` and `address.test.ts`. The spoofing test
`rejects a rumor whose author does not match the seal` must pass; if it does
not, stop — the security model is not in place.

- [ ] **Step 5: Typecheck**

Run: `cd nostr-bridge && npx tsc -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add nostr-bridge/src/protocol
git commit -m "Add seal/wrap/unwrap with NIP-59 verification rules

Rejects the author-mismatch spoof that nostr-tools' unwrapEvent allows."
```

---

### Task 3: Bridge config and NIP-05 lookup

Adds the config the rewritten pipelines need and makes NIP-05 distinguish "not found" from "lookup failed" — the 550/451 split in §6A depends on it.

**Files:**
- Modify: `nostr-bridge/src/nip05.ts`, `nostr-bridge/src/config.ts`
- Create: `nostr-bridge/src/nip05.test.ts`

**Interfaces:**
- Consumes: `normalizeLocalpart` (Task 1).
- Produces: `lookupNip05(address: string, baseUrl?: string): Promise<Nip05Result>` where
  `type Nip05Result = { status: "found"; pubkey: string } | { status: "not-found" } | { status: "error"; message: string }`.
  Config gains `localDomains: string[]` and `bridgeRelays: string[]`.

- [ ] **Step 1: Write the failing test**

Create `nostr-bridge/src/nip05.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupNip05 } from "./nip05.js";

const PUBKEY = "a".repeat(64);

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe("lookupNip05", () => {
  it("returns the pubkey when the name is registered", async () => {
    mockFetch(() => new Response(JSON.stringify({ names: { alice: PUBKEY } })));
    expect(await lookupNip05("alice@mailstr.app")).toEqual({
      status: "found", pubkey: PUBKEY,
    });
  });

  it("normalizes the localpart before lookup", async () => {
    const f = vi.fn(() => new Response(JSON.stringify({ names: { alice: PUBKEY } })));
    vi.stubGlobal("fetch", f);
    await lookupNip05("Alice+news@mailstr.app");
    expect(String(f.mock.calls[0][0])).toContain("name=alice");
  });

  it("returns not-found for an unregistered name", async () => {
    mockFetch(() => new Response(JSON.stringify({ names: {} })));
    expect(await lookupNip05("nobody@mailstr.app")).toEqual({ status: "not-found" });
  });

  it("returns not-found on 404", async () => {
    mockFetch(() => new Response("", { status: 404 }));
    expect(await lookupNip05("nobody@mailstr.app")).toEqual({ status: "not-found" });
  });

  // Must NOT collapse into not-found: a 500 is retryable (451), an absent
  // name is permanent (550). See §6A step 2.
  it("returns error on a 500", async () => {
    mockFetch(() => new Response("", { status: 500 }));
    expect((await lookupNip05("alice@mailstr.app")).status).toBe("error");
  });

  it("returns error when the network throws", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    expect((await lookupNip05("alice@mailstr.app")).status).toBe("error");
  });

  it("returns error for an address with no @", async () => {
    expect((await lookupNip05("alice")).status).toBe("error");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd nostr-bridge && pnpm test src/nip05.test.ts`
Expected: FAIL — `lookupNip05 is not a function`.

- [ ] **Step 3: Rewrite `nip05.ts`**

Replace the entire contents of `nostr-bridge/src/nip05.ts`:

```ts
import { normalizeLocalpart, splitAddress } from "./protocol/address.js";

export type Nip05Result =
  | { status: "found"; pubkey: string }
  | { status: "not-found" }
  | { status: "error"; message: string };

/**
 * Resolve an address through NIP-05.
 *
 * The three outcomes are deliberately distinct. "not-found" is permanent and
 * must produce a 550; "error" is transient and must produce a 451. Collapsing
 * them (as the previous `null`-returning version did) turns a backend outage
 * into a permanent bounce for every inbound message.
 */
export async function lookupNip05(
  address: string,
  baseUrl?: string,
): Promise<Nip05Result> {
  const parts = splitAddress(address);
  if (!parts) return { status: "error", message: `malformed address: ${address}` };

  const name = normalizeLocalpart(address);
  const base = baseUrl ?? `https://${parts.domain}`;
  const url = `${base}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }

  if (res.status === 404) return { status: "not-found" };
  if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };

  let body: { names?: Record<string, string> };
  try {
    body = (await res.json()) as { names?: Record<string, string> };
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }

  const pubkey = body.names?.[name];
  return pubkey ? { status: "found", pubkey } : { status: "not-found" };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd nostr-bridge && pnpm test`
Expected: PASS — 7 new tests, previous ones still green.

- [ ] **Step 5: Extend config**

In `nostr-bridge/src/config.ts`, replace the `allowedDomains` entry with:

```ts
  // Domains this deployment accepts mail for and serves NIP-05 records for.
  // Outbound From addresses MUST be on one of these (§5); the bridge refuses
  // to deliver TO them (§6B step 5) since they are reachable over Nostr.
  localDomains: (process.env.LOCAL_DOMAINS ?? process.env.ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Relays the bridge itself listens and publishes its own 10050/kind-0 on.
  bridgeRelays: (process.env.BRIDGE_RELAYS ?? process.env.BOOTSTRAP_RELAYS ?? "wss://relay.damus.io,wss://relay.nostr.band")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
```

Then add, immediately after the `config` object:

```ts
// Fail fast rather than silently running as an open relay: with no local
// domains configured there is no address the bridge can verify ownership of,
// so every outbound message would have to be rejected anyway (§5).
if (config.localDomains.length === 0) {
  throw new Error(
    "Missing required env var: LOCAL_DOMAINS (comma-separated, e.g. mailstr.app)",
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `cd nostr-bridge && npx tsc -p tsconfig.json`
Expected: errors in `lmtp-server.ts` and `nostr-listener.ts` — they still call the deleted `lookupNip05Pubkey` and `config.allowedDomains`. That is expected; Tasks 4 and 5 fix them. Do not fix them here.

- [ ] **Step 7: Commit**

```bash
git add nostr-bridge/src/nip05.ts nostr-bridge/src/nip05.test.ts nostr-bridge/src/config.ts
git commit -m "Split NIP-05 not-found from lookup-error; require LOCAL_DOMAINS

The 550/451 distinction depends on telling an unregistered name apart from
a backend outage. Refusing to boot without LOCAL_DOMAINS closes the
open-relay default."
```

---

### Task 4: Bridge inbound — SMTP to Nostr

Rewrites §6A. Preserves the raw RFC 2822, publishes to kind-10050 relays, and deletes the per-recipient pseudonym scheme.

**Files:**
- Modify: `nostr-bridge/src/nostr-publisher.ts`, `nostr-bridge/src/lmtp-server.ts`, `nostr-bridge/src/user-resolver.ts`
- Delete: `nostr-bridge/src/key-derivation.ts`
- Create: `nostr-bridge/src/nostr-publisher.test.ts`

**Interfaces:**
- Consumes: `buildMailRumor`, `sealAndWrap`, `keySigner`, `KIND_DM_RELAYS`, `lookupNip05`.
- Produces: `publishMail(params: { raw: string; recipientPubkey: string; signer: ProtocolSigner; relays: string[] }): Promise<boolean>`; `UserResolver.getDmRelays(pubkey: string): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

Create `nostr-bridge/src/nostr-publisher.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { keySigner } from "./protocol/key-signer.js";
import { unwrapAndVerify } from "./protocol/mail.js";
import { buildInboundWrap } from "./nostr-publisher.js";

const RAW = [
  "From: Bob <bob@gmail.com>",
  "To: alice@mailstr.app",
  "Subject: lunch?",
  "Message-ID: <abc@gmail.com>",
  "",
  "are you free thursday",
].join("\r\n");

describe("buildInboundWrap", () => {
  it("preserves the original RFC 2822 byte for byte", async () => {
    const bridgeSk = generateSecretKey();
    const aliceSk = generateSecretKey();
    const alicePk = getPublicKey(aliceSk);

    const wrap = await buildInboundWrap(RAW, alicePk, keySigner(bridgeSk));
    const result = await unwrapAndVerify(wrap, keySigner(aliceSk));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The whole point: From, Message-ID and every other header survive, so
    // the recipient can reply and threading works.
    expect(result.rumor.content).toBe(RAW);
    expect(result.seal.pubkey).toBe(getPublicKey(bridgeSk));
  });

  it("carries no deliver tags — inbound mail is not for relaying", async () => {
    const bridgeSk = generateSecretKey();
    const aliceSk = generateSecretKey();

    const wrap = await buildInboundWrap(RAW, getPublicKey(aliceSk), keySigner(bridgeSk));
    const result = await unwrapAndVerify(wrap, keySigner(aliceSk));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rumor.tags.filter((t) => t[0] === "deliver")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd nostr-bridge && pnpm test src/nostr-publisher.test.ts`
Expected: FAIL — `buildInboundWrap` is not exported.

- [ ] **Step 3: Rewrite `nostr-publisher.ts`**

Replace the entire contents of `nostr-bridge/src/nostr-publisher.ts`:

```ts
import WebSocket from "ws";
import type { Event } from "nostr-tools";
import { buildMailRumor, sealAndWrap } from "./protocol/mail.js";
import type { ProtocolSigner } from "./protocol/types.js";

function publishToRelay(relayUrl: string, event: Event, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };

    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => finish(false), timeoutMs);

    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data[0] === "OK" && data[1] === event.id) finish(Boolean(data[2]));
      } catch {
        // ignore malformed relay frames
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
): Promise<Event> {
  const rumor = buildMailRumor({
    senderPubkey: await signer.getPublicKey(),
    recipientPubkey,
    rfc2822: raw,
  });
  return sealAndWrap(rumor, recipientPubkey, signer);
}

/** Returns true if at least one relay accepted the event. */
export async function publishMail(params: {
  raw: string;
  recipientPubkey: string;
  signer: ProtocolSigner;
  relays: string[];
}): Promise<boolean> {
  const wrap = await buildInboundWrap(params.raw, params.recipientPubkey, params.signer);
  const results = await Promise.all(
    params.relays.map((relay) => publishToRelay(relay, wrap)),
  );
  return results.some(Boolean);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd nostr-bridge && pnpm test src/nostr-publisher.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Point the user resolver at kind 10050**

Replace `resolveFromNetwork` and `getPreferences` in `nostr-bridge/src/user-resolver.ts` with:

```ts
  /**
   * The recipient's DM relays. NIP-17: "Clients MUST only publish events to
   * the relays listed in the recipient's kind 10050 event." Querying kind
   * 10002 (general write relays) instead put inbound mail on relays the
   * client never subscribes to.
   */
  async getDmRelays(pubkey: string): Promise<string[]> {
    const cached = this.cache.get(pubkey);
    if (cached) return cached.relays;

    const relays = await this.resolveFromNetwork(pubkey);
    this.cache.set(pubkey, { relays });
    return relays;
  }

  private async resolveFromNetwork(pubkey: string): Promise<string[]> {
    let events: Event[] = [];
    try {
      events = await this.pool.querySync(
        this.bootstrapRelays,
        { kinds: [KIND_DM_RELAYS], authors: [pubkey] },
        { maxWait: 4000 },
      );
    } catch {
      events = [];
    }

    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (!latest) return this.defaultRelays;

    const relays = latest.tags
      .filter((t) => t[0] === "relay" && t[1])
      .map((t) => t[1]);
    return relays.length > 0 ? relays : this.defaultRelays;
  }
```

Update the top of the file to match — replace the `UserPreferences` interface and the constructor:

```ts
import { LRUCache } from "lru-cache";
import type { Event } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { KIND_DM_RELAYS } from "./protocol/constants.js";

export class UserResolver {
  private cache: LRUCache<string, { relays: string[] }>;
  private pool = new SimplePool();

  constructor(
    private bootstrapRelays: string[],
    private defaultRelays: string[],
    maxEntries: number,
    ttlMs: number,
  ) {
    this.cache = new LRUCache({ max: maxEntries, ttl: ttlMs });
  }
```

- [ ] **Step 6: Rewrite the LMTP handler**

Replace `handleMessage` in `nostr-bridge/src/lmtp-server.ts`:

```ts
  async function handleMessage(
    raw: Buffer,
    recipient: string | undefined,
  ): Promise<void> {
    if (!recipient) throw new LmtpError("5.1.1 No recipient", 550);

    const lookup = await lookupNip05(recipient, config.nip05BaseUrl);

    // Permanent vs transient must stay distinct: 550 bounces to the real
    // sender, 451 makes Postfix retry. Treating an outage as 550 loses mail.
    if (lookup.status === "error") {
      console.error(`nostr-bridge: NIP-05 lookup failed for ${recipient}: ${lookup.message}`);
      throw new LmtpError("4.3.0 NIP-05 lookup failed", 451);
    }
    if (lookup.status === "not-found") {
      throw new LmtpError("5.1.1 Recipient not registered", 550);
    }

    const relays = await userResolver.getDmRelays(lookup.pubkey);

    let published: boolean;
    try {
      published = await publishMail({
        raw: raw.toString("utf8"),
        recipientPubkey: lookup.pubkey,
        signer: bridgeSigner,
        relays,
      });
    } catch (error) {
      console.error("nostr-bridge: publish threw:", (error as Error).message);
      throw new LmtpError("4.3.0 Nostr publish failed", 451);
    }

    // Never ACK a message that reached no relay — a 250 tells the peer it was
    // delivered and it is then gone forever.
    if (!published) throw new LmtpError("4.3.0 No relay accepted the message", 451);

    console.log(`nostr-bridge: delivered mail for ${recipient} to ${relays.length} relay(s)`);
  }
```

Update that file's imports:

```ts
import { SMTPServer } from "smtp-server";
import { lookupNip05 } from "./nip05.js";
import { UserResolver } from "./user-resolver.js";
import { publishMail } from "./nostr-publisher.js";
import { keySigner } from "./protocol/key-signer.js";
import { config } from "./config.js";

const bridgeSigner = keySigner(config.bridgePrivkey);
```

`parseEmail` and its import are no longer used here — remove them. The raw
bytes go through untouched.

- [ ] **Step 7: Delete the pseudonym scheme**

```bash
git rm nostr-bridge/src/key-derivation.ts
```

If `blossom-client.ts` imports `deriveSecretKey`, change it to take a
`Uint8Array` secret key parameter supplied by its caller instead. Attachments
are out of scope (§10), so no other behaviour changes.

- [ ] **Step 8: Update the composition root**

In `nostr-bridge/src/index.ts`, update the `UserResolver` construction to the new signature:

```ts
const userResolver = new UserResolver(
  config.bootstrapRelays,
  config.bridgeRelays,
  config.relayCacheMax,
  config.relayCacheTtlMs,
);
```

- [ ] **Step 9: Typecheck and test**

Run: `cd nostr-bridge && npx tsc -p tsconfig.json && pnpm test`
Expected: `nostr-listener.ts` still errors (Task 5 rewrites it). All tests pass.

- [ ] **Step 10: Commit**

```bash
git add -A nostr-bridge
git commit -m "Rewrite bridge inbound: kind 1301, raw RFC 2822, kind-10050 relays

Preserves the original message so From and Message-ID survive, making
replies and threading possible. Drops the per-recipient pseudonym scheme,
whose replies were never delivered anywhere."
```

---

### Task 5: Bridge outbound — Nostr to SMTP

Rewrites §6B: seal-based authorization, `deliver`-tag envelope, local-target rejection, replay guard, bounces.

**Files:**
- Modify: `nostr-bridge/src/nostr-listener.ts`
- Create: `nostr-bridge/src/outbound.ts`, `nostr-bridge/src/outbound.test.ts`

**Interfaces:**
- Consumes: `unwrapAndVerify`, `deliverTargets`, `lookupNip05`, `splitAddress`, `normalizeLocalpart`, `keySigner`.
- Produces: `authorizeSender(params: { from: string; sealPubkey: string; localDomains: string[]; nip05BaseUrl?: string }): Promise<AuthResult>` where
  `type AuthResult = { ok: true; address: string } | { ok: false; reason: string }`;
  `selectDeliverTargets(targets: string[], localDomains: string[]): { deliver: string[]; rejected: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `nostr-bridge/src/outbound.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { authorizeSender, selectDeliverTargets } from "./outbound.js";

const ALICE = "a".repeat(64);
const MALLORY = "b".repeat(64);
const LOCAL = ["mailstr.app"];

function mockNames(names: Record<string, string>) {
  vi.stubGlobal("fetch", vi.fn(() => new Response(JSON.stringify({ names }))));
}

afterEach(() => vi.unstubAllGlobals());

describe("authorizeSender", () => {
  it("accepts a From the sealer provably owns", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "alice@mailstr.app", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result).toEqual({ ok: true, address: "alice@mailstr.app" });
  });

  // The §5 attack, at the authorization layer.
  it("rejects a From owned by someone else", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "alice@mailstr.app", sealPubkey: MALLORY, localDomains: LOCAL,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a From on a non-local domain", async () => {
    const result = await authorizeSender({
      from: "someone@gmail.com", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("gmail.com");
  });

  it("rejects an unregistered local name", async () => {
    mockNames({});
    const result = await authorizeSender({
      from: "ghost@mailstr.app", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result.ok).toBe(false);
  });

  it("authorizes plus-addressed and mixed-case From against the base name", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "Alice+news@mailstr.app", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed when the lookup errors", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
    const result = await authorizeSender({
      from: "alice@mailstr.app", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result.ok).toBe(false);
  });
});

describe("selectDeliverTargets", () => {
  it("keeps external targets", () => {
    expect(selectDeliverTargets(["b@gmail.com", "c@yahoo.com"], LOCAL)).toEqual({
      deliver: ["b@gmail.com", "c@yahoo.com"],
      rejected: [],
    });
  });

  // §6B step 5: local mailboxes are reachable over Nostr. Relaying to them
  // here would bypass the inbound path's rules.
  it("rejects local-domain targets", () => {
    expect(selectDeliverTargets(["b@gmail.com", "eve@mailstr.app"], LOCAL)).toEqual({
      deliver: ["b@gmail.com"],
      rejected: ["eve@mailstr.app"],
    });
  });

  it("deduplicates case-insensitively", () => {
    expect(selectDeliverTargets(["B@Gmail.com", "b@gmail.com"], LOCAL).deliver)
      .toEqual(["B@Gmail.com"]);
  });

  it("drops malformed addresses", () => {
    expect(selectDeliverTargets(["nope", "b@gmail.com"], LOCAL)).toEqual({
      deliver: ["b@gmail.com"],
      rejected: ["nope"],
    });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd nostr-bridge && pnpm test src/outbound.test.ts`
Expected: FAIL — `Failed to resolve import "./outbound.js"`.

- [ ] **Step 3: Implement `outbound.ts`**

Create `nostr-bridge/src/outbound.ts`:

```ts
import { lookupNip05 } from "./nip05.js";
import { normalizeLocalpart, splitAddress } from "./protocol/address.js";

export type AuthResult =
  | { ok: true; address: string }
  | { ok: false; reason: string };

/**
 * May this sealer send as this From address? (§5)
 *
 * Two independent facts are combined: the seal signature proves possession of
 * sealPubkey, and the NIP-05 record proves the backend assigned that name to
 * that pubkey. Anything else is refused — including every transient failure,
 * because an unverifiable sender must not be relayed.
 *
 * sealPubkey MUST come from the kind-13 seal. rumor.pubkey is attacker-chosen
 * plaintext inside the ciphertext and proves nothing.
 */
export async function authorizeSender(params: {
  from: string;
  sealPubkey: string;
  localDomains: string[];
  nip05BaseUrl?: string;
}): Promise<AuthResult> {
  const parts = splitAddress(params.from);
  if (!parts) return { ok: false, reason: `malformed From address: ${params.from}` };

  if (!params.localDomains.includes(parts.domain)) {
    return {
      ok: false,
      reason: `Domain "${parts.domain}" is not served by this bridge`,
    };
  }

  const lookup = await lookupNip05(params.from, params.nip05BaseUrl);
  if (lookup.status === "error") {
    return { ok: false, reason: `NIP-05 lookup failed: ${lookup.message}` };
  }
  if (lookup.status === "not-found") {
    return { ok: false, reason: `No NIP-05 record for ${params.from}` };
  }
  if (lookup.pubkey !== params.sealPubkey) {
    return { ok: false, reason: `${params.from} is not owned by the sending key` };
  }

  return { ok: true, address: `${normalizeLocalpart(params.from)}@${parts.domain}` };
}

/**
 * Split the envelope into addresses this bridge will deliver to and ones it
 * refuses. Local-domain targets are refused: they are reachable directly over
 * Nostr, and relaying to them here would bypass the inbound rules (§6B).
 */
export function selectDeliverTargets(
  targets: string[],
  localDomains: string[],
): { deliver: string[]; rejected: string[] } {
  const deliver: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const parts = splitAddress(target);
    if (!parts) {
      rejected.push(target);
      continue;
    }
    if (localDomains.includes(parts.domain)) {
      rejected.push(target);
      continue;
    }
    const key = `${parts.localpart}@${parts.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deliver.push(target);
  }

  return { deliver, rejected };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd nostr-bridge && pnpm test src/outbound.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Rewrite the listener**

Replace the entire contents of `nostr-bridge/src/nostr-listener.ts`:

```ts
import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools";
import { config } from "./config.js";
import { keySigner } from "./protocol/key-signer.js";
import { unwrapAndVerify, deliverTargets, buildMailRumor, sealAndWrap } from "./protocol/mail.js";
import { KIND_GIFTWRAP, MAX_RUMOR_AGE_SECONDS } from "./protocol/constants.js";
import { authorizeSender, selectDeliverTargets } from "./outbound.js";
import { createPostfixTransport, injectIntoPostfix } from "./smtp-injector.js";

const bridgeSigner = keySigner(config.bridgePrivkey);

/** Bounded set of rumor ids already processed — the replay guard's fast path. */
const processed = new Set<string>();
const PROCESSED_MAX = 50_000;

function remember(id: string): boolean {
  if (processed.has(id)) return false;
  if (processed.size >= PROCESSED_MAX) processed.clear();
  processed.add(id);
  return true;
}

async function sendBounce(
  pool: SimplePool,
  relays: string[],
  recipientPubkey: string,
  reason: string,
): Promise<void> {
  const body = [
    `From: postmaster@${config.localDomains[0]}`,
    `To: <${recipientPubkey}>`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: Mail delivery failed`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Your message could not be delivered.`,
    ``,
    `Reason: ${reason}`,
  ].join("\r\n");

  try {
    const rumor = buildMailRumor({
      senderPubkey: await bridgeSigner.getPublicKey(),
      recipientPubkey,
      rfc2822: body,
    });
    const wrap = await sealAndWrap(rumor, recipientPubkey, bridgeSigner);
    await Promise.allSettled(pool.publish(relays, wrap));
  } catch (err) {
    console.error("nostr-bridge: failed to send bounce:", (err as Error).message);
  }
}

async function handleWrap(
  pool: SimplePool,
  relays: string[],
  transport: ReturnType<typeof createPostfixTransport>,
  event: Event,
): Promise<void> {
  const result = await unwrapAndVerify(event, bridgeSigner, {
    maxAgeSeconds: MAX_RUMOR_AGE_SECONDS,
  });

  if (!result.ok) {
    // "not-for-us" is routine — relays hand us every wrap p-tagged to us.
    // Everything else means something is broken or hostile: log it (§8).
    if (result.reason !== "not-for-us") {
      console.warn(`nostr-bridge: rejected wrap ${event.id.slice(0, 8)}: ${result.reason}`);
    }
    return;
  }

  const { seal, rumor } = result;
  if (!remember(rumor.id)) {
    console.warn(`nostr-bridge: duplicate rumor ${rumor.id.slice(0, 8)}, dropping`);
    return;
  }

  const fromMatch = /^From:\s*(.*)$/im.exec(rumor.content);
  const fromHeader = fromMatch?.[1]?.trim() ?? "";
  const angle = /<([^>]+)>/.exec(fromHeader);
  const fromAddress = (angle?.[1] ?? fromHeader).trim();

  const auth = await authorizeSender({
    from: fromAddress,
    sealPubkey: seal.pubkey,
    localDomains: config.localDomains,
    nip05BaseUrl: config.nip05BaseUrl,
  });

  if (!auth.ok) {
    console.warn(`nostr-bridge: unauthorized send from ${seal.pubkey.slice(0, 8)}: ${auth.reason}`);
    await sendBounce(pool, relays, seal.pubkey, auth.reason);
    return;
  }

  const { deliver, rejected } = selectDeliverTargets(
    deliverTargets(rumor),
    config.localDomains,
  );

  if (rejected.length) {
    console.warn(`nostr-bridge: refused deliver targets: ${rejected.join(", ")}`);
  }
  if (deliver.length === 0) {
    console.warn(`nostr-bridge: rumor ${rumor.id.slice(0, 8)} has no deliverable targets`);
    await sendBounce(pool, relays, seal.pubkey, "No deliverable recipients");
    return;
  }

  try {
    // One message, N envelope recipients. Routing comes from the deliver
    // tags, never from the To: header — the header is what recipients see,
    // the envelope is who this hop delivers to (§4).
    await injectIntoPostfix(transport, {
      envelope: { from: auth.address, to: deliver },
      raw: rumor.content,
    });
    console.log(`nostr-bridge: relayed from ${auth.address} to ${deliver.join(", ")}`);
  } catch (err) {
    console.error("nostr-bridge: Postfix injection failed:", (err as Error).message);
    await sendBounce(pool, relays, seal.pubkey, "Downstream mail server unavailable");
  }
}

export async function startNostrListener(
  transport: ReturnType<typeof createPostfixTransport>,
): Promise<void> {
  const pool = new SimplePool({ enableReconnect: true });
  const relays = config.bridgeRelays;

  console.log(`nostr-bridge: listening on ${relays.join(", ")}`);
  console.log(`nostr-bridge: serving domains ${config.localDomains.join(", ")}`);

  pool.subscribeMany(
    relays,
    { kinds: [KIND_GIFTWRAP], "#p": [config.bridgePubkey], since: Math.floor(Date.now() / 1000) },
    {
      onevent: (event) => void handleWrap(pool, relays, transport, event),
    },
  );
}
```

- [ ] **Step 6: Widen the injector's envelope type**

In `nostr-bridge/src/smtp-injector.ts`, the envelope `to` must accept an array.
Confirm the type is `to: string | string[]`; if it is `to: string`, widen it.
nodemailer already accepts both.

- [ ] **Step 7: Typecheck and run everything**

Run: `cd nostr-bridge && npx tsc -p tsconfig.json && pnpm test`
Expected: no typecheck output; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A nostr-bridge
git commit -m "Rewrite bridge outbound: authorize on seal.pubkey, deliver-tag envelope

Closes the sender-spoofing hole (authorization read rumor.pubkey, which is
attacker-controlled), fixes multi-recipient delivery, refuses to relay to
local domains, and adds a replay guard."
```

---

### Task 6: Bridge self-publication

Without kind 10050 and kind 0, clients cannot discover where to send, and `_smtp` resolution points at a pubkey with no profile (§6, Known-broken 8).

**Files:**
- Create: `nostr-bridge/src/self-publish.ts`
- Modify: `nostr-bridge/src/index.ts`

**Interfaces:**
- Consumes: `keySigner`, `KIND_DM_RELAYS`, `KIND_PROFILE`, config.
- Produces: `publishBridgeIdentity(pool: SimplePool, relays: string[], signer: ProtocolSigner, domain: string): Promise<void>`.

- [ ] **Step 1: Write `self-publish.ts`**

```ts
import { SimplePool } from "nostr-tools/pool";
import { nip19 } from "nostr-tools";
import { KIND_DM_RELAYS, KIND_PROFILE } from "./protocol/constants.js";
import type { ProtocolSigner } from "./protocol/types.js";

/**
 * Announce the bridge so clients can find it: a kind-10050 saying which
 * relays to send mail to, and a kind-0 whose nip05 matches the _smtp record
 * clients resolve. Without these, delivery works only when the client's and
 * bridge's default relay lists happen to overlap.
 */
export async function publishBridgeIdentity(
  pool: SimplePool,
  relays: string[],
  signer: ProtocolSigner,
  domain: string,
): Promise<void> {
  const pubkey = await signer.getPublicKey();
  const created_at = Math.floor(Date.now() / 1000);

  const dmRelayList = await signer.signEvent({
    kind: KIND_DM_RELAYS,
    pubkey,
    created_at,
    tags: relays.map((relay) => ["relay", relay]),
    content: "",
  });

  const profile = await signer.signEvent({
    kind: KIND_PROFILE,
    pubkey,
    created_at,
    tags: [],
    content: JSON.stringify({
      name: `${domain} mail bridge`,
      about: `SMTP bridge for ${domain}. Send kind 1301 gift wraps here to reach legacy email.`,
      nip05: `_smtp@${domain}`,
    }),
  });

  const results = await Promise.allSettled([
    ...pool.publish(relays, dmRelayList),
    ...pool.publish(relays, profile),
  ]);
  const accepted = results.filter((r) => r.status === "fulfilled").length;

  console.log(`nostr-bridge: npub ${nip19.npubEncode(pubkey)}`);
  console.log(`nostr-bridge: published identity to ${accepted}/${results.length} relay slots`);

  if (accepted === 0) {
    console.error("nostr-bridge: WARNING — no relay accepted the identity events; clients may not find this bridge");
  }
}
```

- [ ] **Step 2: Call it on boot**

In `nostr-bridge/src/index.ts`, after the listener starts, add:

```ts
import { SimplePool } from "nostr-tools/pool";
import { publishBridgeIdentity } from "./self-publish.js";
import { keySigner } from "./protocol/key-signer.js";

// …after startNostrListener(...)
await publishBridgeIdentity(
  new SimplePool(),
  config.bridgeRelays,
  keySigner(config.bridgePrivkey),
  config.localDomains[0],
);
```

- [ ] **Step 3: Verify it boots and logs its npub**

Run:
```bash
cd nostr-bridge && NOSTR_BRIDGE_NSEC=$(node -e "import('nostr-tools/pure').then(m=>console.log(require('nostr-tools/nip19').nsecEncode(m.generateSecretKey())))" 2>/dev/null || echo "") LOCAL_DOMAINS=mailstr.app npx tsx src/index.ts
```
Expected: logs `nostr-bridge: npub npub1…` and a published-identity count.
Stop it with Ctrl-C.

If generating the nsec inline fails, generate one separately:
```bash
node -e "const p=require('nostr-tools/pure'),n=require('nostr-tools/nip19');console.log(n.nsecEncode(p.generateSecretKey()))"
```

- [ ] **Step 4: Commit**

```bash
git add nostr-bridge/src/self-publish.ts nostr-bridge/src/index.ts
git commit -m "Publish bridge kind-10050 and kind-0 at startup

Clients could not discover the bridge's relays; delivery relied on default
relay lists happening to overlap."
```

---

### Task 7: Client wiring for the protocol module

Makes the shared module importable from the browser build — including inside Docker, where the client's build context currently excludes `nostr-bridge/`.

**Files:**
- Modify: `client/vite.config.ts`, `client/tsconfig.app.json`, `client/package.json`, `client/Dockerfile`, `docker-compose.yml`
- Create: `client/vitest.config.ts`, `client/src/lib/nostr/protocol-signer.ts`, `client/.dockerignore`

**Interfaces:**
- Consumes: `ProtocolSigner` (Task 1).
- Produces: import alias `@protocol` resolving to `nostr-bridge/src/protocol`; `protocolSigner(active: ActiveSigner): ProtocolSigner`.

- [ ] **Step 1: Add the alias and a test runner**

```bash
cd client && pnpm add -D vitest@^3.0.0
```

Add to `client/package.json` `scripts`: `"test": "vitest run"`.

In `client/vite.config.ts`, extend `resolve.alias`:

```ts
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@protocol": path.resolve(__dirname, "../nostr-bridge/src/protocol"),
    },
```

In `client/tsconfig.app.json`, extend `paths`:

```json
    "paths": {
      "@/*": ["src/*"],
      "@protocol/*": ["../nostr-bridge/src/protocol/*"],
      "@protocol": ["../nostr-bridge/src/protocol/index.ts"]
    }
```

and extend `include`:

```json
  "include": ["src", "../nostr-bridge/src/protocol"]
```

Create `client/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@protocol": path.resolve(__dirname, "../nostr-bridge/src/protocol"),
    },
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
```

- [ ] **Step 2: Fix the Docker build context**

The client image currently builds with `context: client`, so
`../nostr-bridge` does not exist inside the build and the alias fails at
`vite build`. Move the context to the repo root.

In `docker-compose.yml`, change the `client-deploy` build block:

```yaml
    build:
      context: .
      dockerfile: client/Dockerfile
      args:
        CLIENT_BASE_PATH: ${CLIENT_BASE_PATH:-/mails/}
        VITE_BRIDGE_DOMAIN: ${VITE_BRIDGE_DOMAIN:-mailstr.app}
```

In `client/Dockerfile`, replace lines 15-18 with root-relative paths:

```dockerfile
COPY client/package.json client/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# The client imports the shared protocol module from nostr-bridge, so it must
# be inside the build context (docker-compose sets context to the repo root).
COPY client/ ./
COPY nostr-bridge/src/protocol/ /nostr-bridge/src/protocol/
```

Because `../nostr-bridge` must resolve from `/app`, place the copy at
`/nostr-bridge`. Add to `client/Dockerfile` before `RUN pnpm run build`:

```dockerfile
WORKDIR /app
```

Create `client/.dockerignore`:

```
node_modules
dist
```

- [ ] **Step 3: Write the signer adapter**

Create `client/src/lib/nostr/protocol-signer.ts`:

```ts
import type { ActiveSigner } from '@formstr/signer'
import type { ProtocolSigner } from '@protocol'
import { withSignerTimeout } from './signer'

/**
 * Adapts @formstr/signer to the protocol module's ProtocolSigner.
 *
 * Every call is bounded: an unresponsive NIP-46 bunker otherwise hangs
 * forever, and the seal now puts two signer calls on the critical path per
 * recipient (§11).
 */
export function protocolSigner(active: ActiveSigner): ProtocolSigner {
  return {
    getPublicKey: () => withSignerTimeout('getPublicKey', () => active.getPublicKey()),
    nip44Encrypt: (peer, plaintext) =>
      withSignerTimeout('nip44Encrypt', () => active.nip44Encrypt(peer, plaintext)),
    nip44Decrypt: (peer, ciphertext) =>
      withSignerTimeout('nip44Decrypt', () => active.nip44Decrypt(peer, ciphertext)),
    signEvent: (event) => withSignerTimeout('signEvent', () => active.signEvent(event)),
  }
}
```

If `ActiveSigner`'s method names differ, read
`client/src/lib/nostr/signer.ts` and match them exactly — that file already
wraps this interface for the existing decrypt path.

- [ ] **Step 4: Verify the alias resolves in a test**

Create `client/src/lib/nostr/protocol-signer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { KIND_MAIL, buildMailRumor } from '@protocol'

describe('protocol module import', () => {
  it('resolves through the @protocol alias', () => {
    expect(KIND_MAIL).toBe(1301)
    const rumor = buildMailRumor({
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      rfc2822: 'From: a@b.c\r\n\r\nhi',
    })
    expect(rumor.kind).toBe(1301)
  })
})
```

Run: `cd client && pnpm test`
Expected: PASS.

- [ ] **Step 5: Verify the browser build**

Run: `cd client && npx tsc --noEmit -p tsconfig.app.json && npx vite build`
Expected: both succeed. A failure mentioning `node:crypto` or `Buffer` means
the protocol module violated the global constraint — fix it there, not here.

- [ ] **Step 6: Commit**

```bash
git add client docker-compose.yml
git commit -m "Wire the shared protocol module into the client build

Moves the client Docker build context to the repo root so nostr-bridge's
protocol module is reachable."
```

---

### Task 8: Client recipient resolution

Implements §7: the resolution algorithm, the bounded cached probe, and bridge discovery.

**Files:**
- Modify: `client/src/lib/nostr/nip05.ts`, `client/src/lib/mail/resolve.ts`
- Create: `client/src/lib/nostr/bridge.ts`, `client/src/lib/mail/resolve.test.ts`

**Interfaces:**
- Consumes: `isNpub`, `isHexPubkey`, `splitAddress` from `@protocol`.
- Produces:
  - `probeNip05(address: string): Promise<string | null>` — bounded, cached.
  - `resolveBridge(ownDomain: string, override?: string): Promise<string | null>`
  - `resolveRecipients(addresses: string[], ctx: ResolveContext): Promise<ResolveOutcome>` where
    `interface ResolveContext { localDomains: string[]; ownDomain: string; bridgePubkey: string | null }` and
    `interface ResolveOutcome { nostr: Array<{ pubkey: string; headerAddress: string }>; legacy: string[]; errors: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/mail/resolve.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveRecipients } from './resolve'
import { clearProbeCache } from '@/lib/nostr/nip05'

const ALICE = 'a'.repeat(64)
const BRIDGE = 'c'.repeat(64)
const CTX = { localDomains: ['mailstr.app'], ownDomain: 'mailstr.app', bridgePubkey: BRIDGE }

function mockNames(names: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ names }))))
}

beforeEach(() => clearProbeCache())
afterEach(() => vi.unstubAllGlobals())

describe('resolveRecipients', () => {
  it('sends mailstr-to-mailstr direct, never via the bridge', async () => {
    mockNames({ alice: ALICE })
    const out = await resolveRecipients(['alice@mailstr.app'], CTX)
    expect(out.nostr).toEqual([{ pubkey: ALICE, headerAddress: 'alice@mailstr.app' }])
    expect(out.legacy).toEqual([])
  })

  it('routes an unknown external domain to the bridge', async () => {
    mockNames({})
    const out = await resolveRecipients(['bob@gmail.com'], CTX)
    expect(out.legacy).toEqual(['bob@gmail.com'])
    expect(out.nostr).toEqual([])
  })

  // §7 step 4: the client already knows this cannot work; bouncing via
  // Postfix would be slower and less truthful.
  it('errors on an unregistered local name instead of routing to the bridge', async () => {
    mockNames({})
    const out = await resolveRecipients(['ghost@mailstr.app'], CTX)
    expect(out.legacy).toEqual([])
    expect(out.errors[0]).toContain('ghost@mailstr.app')
  })

  it('accepts a bare npub and writes an addressable header', async () => {
    const npub = 'npub1' + 'q'.repeat(58)
    const out = await resolveRecipients([npub], CTX)
    expect(out.nostr).toHaveLength(1)
    expect(out.nostr[0].headerAddress).toBe(`${npub}@mailstr.app`)
  })

  it('resolves <npub>@domain straight back to the pubkey', async () => {
    const hex = 'd'.repeat(64)
    const { nip19 } = await import('nostr-tools')
    const npub = nip19.npubEncode(hex)
    const out = await resolveRecipients([`${npub}@mailstr.app`], CTX)
    expect(out.nostr[0].pubkey).toBe(hex)
    expect(out.legacy).toEqual([])
  })

  it('errors for legacy recipients when no bridge is configured', async () => {
    mockNames({})
    const out = await resolveRecipients(['bob@gmail.com'], { ...CTX, bridgePubkey: null })
    expect(out.errors[0]).toMatch(/bridge/i)
  })

  it('probes each domain only once', async () => {
    const f = vi.fn(() => new Response(JSON.stringify({ names: {} })))
    vi.stubGlobal('fetch', f)
    await resolveRecipients(['a@gmail.com'], CTX)
    await resolveRecipients(['b@gmail.com'], CTX)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('treats a probe timeout as legacy rather than hanging', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('timeout'))))
    const out = await resolveRecipients(['bob@example.com'], CTX)
    expect(out.legacy).toEqual(['bob@example.com'])
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd client && pnpm test src/lib/mail/resolve.test.ts`
Expected: FAIL — `resolveRecipients` is not exported.

- [ ] **Step 3: Rewrite the probe**

Replace the entire contents of `client/src/lib/nostr/nip05.ts`:

```ts
import { splitAddress } from '@protocol'

const PROBE_TIMEOUT_MS = 1500
const NEGATIVE_TTL_MS = 24 * 60 * 60_000
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60_000

type Entry = { pubkey: string | null; expires: number }
const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<string | null>>()

/**
 * Domains known not to serve NIP-05. Seeded into the cache rather than used
 * as a routing rule: a stale entry costs one probe, whereas a stale routing
 * blocklist would misroute mail permanently (§7).
 */
const KNOWN_LEGACY = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'proton.me', 'protonmail.com', 'icloud.com', 'me.com', 'aol.com',
]

for (const domain of KNOWN_LEGACY) {
  cache.set(`__domain__:${domain}`, { pubkey: null, expires: Infinity })
}

export function clearProbeCache(): void {
  cache.clear()
  inFlight.clear()
  for (const domain of KNOWN_LEGACY) {
    cache.set(`__domain__:${domain}`, { pubkey: null, expires: Infinity })
  }
}

/**
 * Look up an address via NIP-05, bounded and cached.
 *
 * A timeout is fail-safe, not fail-open: it resolves to null, so the caller
 * routes to the bridge. Worst case is a detour, never a hang.
 */
export async function probeNip05(address: string): Promise<string | null> {
  const parts = splitAddress(address)
  if (!parts) return null

  const domainKey = `__domain__:${parts.domain}`
  const domainEntry = cache.get(domainKey)
  if (domainEntry && domainEntry.expires > Date.now()) return null

  const key = `${parts.localpart}@${parts.domain}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.pubkey

  const pending = inFlight.get(key)
  if (pending) return pending

  const query = (async (): Promise<string | null> => {
    try {
      const res = await fetch(
        `https://${parts.domain}/.well-known/nostr.json?name=${encodeURIComponent(parts.localpart)}`,
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      )
      if (!res.ok) return null
      const json = (await res.json()) as { names?: Record<string, string> }
      return json.names?.[parts.localpart] ?? null
    } catch {
      // CORS failure, 404, timeout — all mean "not Nostr-native here".
      return null
    }
  })()
    .then((pubkey) => {
      cache.set(key, {
        pubkey,
        expires: Date.now() + (pubkey ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
      })
      return pubkey
    })
    .finally(() => inFlight.delete(key))

  inFlight.set(key, query)
  return query
}
```

- [ ] **Step 4: Write bridge discovery**

Create `client/src/lib/nostr/bridge.ts`:

```ts
import { isNpub, isHexPubkey, splitAddress } from '@protocol'
import { nip19 } from 'nostr-tools'
import { probeNip05 } from './nip05'

/**
 * Which bridge relays this user's outbound legacy mail.
 *
 * Defaults to _smtp@<their own mail domain>, mirroring SMTP — your outgoing
 * server is the one run by your mailbox provider. The override exists for
 * self-hosters pointing at their own bridge.
 */
export async function resolveBridge(
  ownDomain: string,
  override?: string,
): Promise<string | null> {
  const input = override?.trim()

  if (input) {
    if (isHexPubkey(input)) return input
    if (isNpub(input)) {
      try {
        const decoded = nip19.decode(input)
        return decoded.type === 'npub' ? (decoded.data as string) : null
      } catch {
        return null
      }
    }
    // NIP-05 address, or a bare domain meaning _smtp@<domain>
    const target = splitAddress(input) ? input : `_smtp@${input}`
    return probeNip05(target)
  }

  return probeNip05(`_smtp@${ownDomain}`)
}
```

- [ ] **Step 5: Rewrite `resolve.ts`**

Replace the entire contents of `client/src/lib/mail/resolve.ts`:

```ts
import { nip19 } from 'nostr-tools'
import { isNpub, isHexPubkey, splitAddress } from '@protocol'
import { probeNip05 } from '@/lib/nostr/nip05'

export interface ResolveContext {
  localDomains: string[]
  ownDomain: string
  bridgePubkey: string | null
}

export interface ResolveOutcome {
  /** Recipients reachable directly over Nostr — one gift wrap each. */
  nostr: Array<{ pubkey: string; headerAddress: string }>
  /** Legacy addresses — ALL of these ride in ONE wrap to the bridge. */
  legacy: string[]
  errors: string[]
}

/**
 * A bare npub is not a valid RFC 2822 addr-spec: a parser reading
 * `To: npub1…` treats the whole thing as a display name with an empty
 * address, which renders as a blank recipient. Write `<npub>@<domain>`.
 */
function nostrHeaderAddress(pubkey: string, domain: string): string {
  return `${nip19.npubEncode(pubkey)}@${domain}`
}

export async function resolveRecipients(
  addresses: string[],
  ctx: ResolveContext,
): Promise<ResolveOutcome> {
  const out: ResolveOutcome = { nostr: [], legacy: [], errors: [] }

  await Promise.all(
    addresses.map(async (address) => {
      const trimmed = address.trim()

      if (isNpub(trimmed)) {
        const pubkey = nip19.decode(trimmed).data as string
        out.nostr.push({ pubkey, headerAddress: nostrHeaderAddress(pubkey, ctx.ownDomain) })
        return
      }

      if (isHexPubkey(trimmed)) {
        out.nostr.push({
          pubkey: trimmed,
          headerAddress: nostrHeaderAddress(trimmed, ctx.ownDomain),
        })
        return
      }

      const parts = splitAddress(trimmed)
      if (!parts) {
        out.errors.push(`Cannot resolve recipient: ${trimmed}`)
        return
      }

      // The header form we write for Nostr-native recipients. Without this a
      // reply would fall through to the bridge and be relayed as legacy mail.
      const rawLocal = trimmed.slice(0, trimmed.indexOf('@'))
      if (isNpub(rawLocal)) {
        out.nostr.push({
          pubkey: nip19.decode(rawLocal).data as string,
          headerAddress: trimmed,
        })
        return
      }

      const pubkey = await probeNip05(trimmed)
      if (pubkey) {
        out.nostr.push({ pubkey, headerAddress: trimmed })
        return
      }

      // A local domain with no NIP-05 record is a mailbox that does not
      // exist. Routing it to the bridge would only earn a slow Postfix bounce.
      if (ctx.localDomains.includes(parts.domain)) {
        out.errors.push(`No such mailbox: ${trimmed}`)
        return
      }

      if (!ctx.bridgePubkey) {
        out.errors.push(`No bridge configured — cannot send to ${trimmed}`)
        return
      }

      out.legacy.push(trimmed)
    }),
  )

  return out
}
```

- [ ] **Step 6: Run the tests**

Run: `cd client && pnpm test src/lib/mail/resolve.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib
git commit -m "Rewrite client recipient resolution

Replaces the isLegacyEmail stub with a real algorithm: bounded cached NIP-05
probe, hard error for unknown local mailboxes, and bridge discovery from the
user's own domain."
```

---

### Task 9: Client send and receive

Rewrites the send path to seal, group, and use `deliver` tags, and the receive path to verify and apply trust rule 5.

**Files:**
- Modify: `client/src/lib/mail/send.ts`, `client/src/lib/mail/receive.ts`, `client/src/lib/nostr/giftwrap.ts`, `client/src/hooks/useInbox.ts`
- Create: `client/src/lib/mail/send.test.ts`

**Interfaces:**
- Consumes: `buildMailRumor`, `sealAndWrap`, `unwrapAndVerify`, `deliverTargets` from `@protocol`; `protocolSigner`; `resolveRecipients`.
- Produces: `sendMail(params: SendMailParams & { ctx: ResolveContext; signer: ProtocolSigner }): Promise<void>`;
  `decodeGiftWrap(event: Event, signer: ProtocolSigner, bridgePubkey: string | null): Promise<Email | null>`.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/mail/send.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { keySigner, unwrapAndVerify, deliverTargets } from '@protocol'
import { buildWraps } from './send'
import { clearProbeCache } from '@/lib/nostr/nip05'

const BRIDGE_SK = generateSecretKey()
const BRIDGE_PK = getPublicKey(BRIDGE_SK)
const ALICE_SK = generateSecretKey()
const ALICE_PK = getPublicKey(ALICE_SK)

const CTX = { localDomains: ['mailstr.app'], ownDomain: 'mailstr.app', bridgePubkey: BRIDGE_PK }

beforeEach(() => {
  clearProbeCache()
  vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ names: {} }))))
})
afterEach(() => vi.unstubAllGlobals())

describe('buildWraps', () => {
  // Known-broken 7: three legacy recipients previously produced three wraps
  // to the same bridge pubkey, and the bridge read only To[0] — so #1 got
  // three copies and #2/#3 got none.
  it('sends ONE bridge wrap carrying every legacy recipient', async () => {
    const { wraps } = await buildWraps({
      from: { address: 'alice@mailstr.app' },
      senderPubkey: ALICE_PK,
      to: ['b@gmail.com', 'c@yahoo.com', 'd@aol.com'],
      subject: 'hi',
      body: 'hello',
      ctx: CTX,
      signer: keySigner(ALICE_SK),
    })

    const toBridge = wraps.filter((w) => w.tags.some((t) => t[0] === 'p' && t[1] === BRIDGE_PK))
    expect(toBridge).toHaveLength(1)

    const result = await unwrapAndVerify(toBridge[0], keySigner(BRIDGE_SK))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(deliverTargets(result.rumor)).toEqual(['b@gmail.com', 'c@yahoo.com', 'd@aol.com'])
  })

  it('always includes a self-copy for the Sent folder', async () => {
    const { wraps } = await buildWraps({
      from: { address: 'alice@mailstr.app' },
      senderPubkey: ALICE_PK,
      to: ['b@gmail.com'],
      subject: 'hi',
      body: 'hello',
      ctx: CTX,
      signer: keySigner(ALICE_SK),
    })
    expect(wraps.some((w) => w.tags.some((t) => t[0] === 'p' && t[1] === ALICE_PK))).toBe(true)
  })

  it('seals with the sender key so the bridge can authorize', async () => {
    const { wraps } = await buildWraps({
      from: { address: 'alice@mailstr.app' },
      senderPubkey: ALICE_PK,
      to: ['b@gmail.com'],
      subject: 'hi',
      body: 'hello',
      ctx: CTX,
      signer: keySigner(ALICE_SK),
    })
    const toBridge = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === BRIDGE_PK))!
    const result = await unwrapAndVerify(toBridge, keySigner(BRIDGE_SK))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.seal.pubkey).toBe(ALICE_PK)
  })

  it('surfaces resolution errors instead of sending', async () => {
    const { errors } = await buildWraps({
      from: { address: 'alice@mailstr.app' },
      senderPubkey: ALICE_PK,
      to: ['ghost@mailstr.app'],
      subject: 'hi',
      body: 'hello',
      ctx: CTX,
      signer: keySigner(ALICE_SK),
    })
    expect(errors[0]).toContain('ghost@mailstr.app')
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd client && pnpm test src/lib/mail/send.test.ts`
Expected: FAIL — `buildWraps` is not exported.

- [ ] **Step 3: Rewrite `send.ts`**

Replace the entire contents of `client/src/lib/mail/send.ts`:

```ts
import type { Event } from 'nostr-tools'
import { buildMailRumor, sealAndWrap, type ProtocolSigner } from '@protocol'
import { fetchDmRelays, publishToRelays } from '@/lib/nostr/relays'
import { buildRfc2822 } from './rfc2822'
import { resolveRecipients, type ResolveContext } from './resolve'
import type { MailAddress } from '@/types/mail'

export interface SendMailParams {
  from: MailAddress
  senderPubkey: string
  to: string[]
  cc?: string[]
  subject: string
  body: string
  bodyHtml?: string
  inReplyTo?: string
  references?: string[]
  ctx: ResolveContext
  signer: ProtocolSigner
}

/**
 * Build every gift wrap this message needs. Split out from sendMail so the
 * wire format is testable without relays.
 *
 * One wrap per Nostr recipient; exactly ONE wrap to the bridge carrying every
 * legacy recipient as a deliver tag; one wrap to self for the Sent folder.
 */
export async function buildWraps(
  params: SendMailParams,
): Promise<{ wraps: Event[]; targets: string[]; errors: string[] }> {
  const { from, senderPubkey, to, cc = [], ctx, signer } = params

  const toOut = await resolveRecipients(to, ctx)
  const ccOut = await resolveRecipients(cc, ctx)
  const errors = [...toOut.errors, ...ccOut.errors]
  if (errors.length) return { wraps: [], targets: [], errors }

  const rfc2822 = buildRfc2822({
    from,
    to: toOut.nostr.map((r) => ({ address: r.headerAddress }))
      .concat(toOut.legacy.map((address) => ({ address }))),
    cc: cc.length
      ? ccOut.nostr.map((r) => ({ address: r.headerAddress }))
          .concat(ccOut.legacy.map((address) => ({ address })))
      : undefined,
    subject: params.subject,
    body: params.body,
    bodyHtml: params.bodyHtml,
    inReplyTo: params.inReplyTo,
    references: params.references,
  })

  const wraps: Event[] = []
  const targets: string[] = []

  const add = async (recipientPubkey: string, deliverTo?: string[]) => {
    const rumor = buildMailRumor({ senderPubkey, recipientPubkey, rfc2822, deliverTo })
    wraps.push(await sealAndWrap(rumor, recipientPubkey, signer))
    targets.push(recipientPubkey)
  }

  for (const r of [...toOut.nostr, ...ccOut.nostr]) await add(r.pubkey)

  const legacy = [...toOut.legacy, ...ccOut.legacy]
  if (legacy.length) {
    if (!ctx.bridgePubkey) {
      return { wraps: [], targets: [], errors: ['No bridge configured — set one in Settings'] }
    }
    await add(ctx.bridgePubkey, legacy)
  }

  await add(senderPubkey)

  return { wraps, targets, errors: [] }
}

export async function sendMail(params: SendMailParams): Promise<void> {
  const { wraps, targets, errors } = await buildWraps(params)
  if (errors.length) throw new Error(errors.join('; '))

  const undelivered: string[] = []

  await Promise.all(
    wraps.map(async (wrap, i) => {
      const pubkey = targets[i]
      const relays = await fetchDmRelays(pubkey)
      const { ok, failed } = await publishToRelays(relays, wrap)
      // Self-copy failure is not a delivery failure; skip it.
      if (pubkey !== params.senderPubkey && !ok.length) {
        undelivered.push(`${pubkey.slice(0, 8)}… (${failed[0]?.error ?? 'no relay accepted it'})`)
      }
    }),
  )

  if (undelivered.length) {
    throw new Error(`Could not deliver to: ${undelivered.join('; ')}`)
  }
}
```

- [ ] **Step 4: Rewrite `receive.ts`**

Replace the `decodeGiftWrap` signature and body in
`client/src/lib/mail/receive.ts`:

```ts
import type { Event } from 'nostr-tools'
import { unwrapAndVerify, type ProtocolSigner } from '@protocol'
import { parseRfc2822 } from './rfc2822'
import type { Email } from '@/types/mail'

export interface DecodeFailure {
  reason: string
  /** True when this is routine (a wrap not addressed to us). */
  routine: boolean
}

export async function decodeGiftWrap(
  event: Event,
  signer: ProtocolSigner,
  bridgePubkey: string | null,
): Promise<{ email: Email } | { failure: DecodeFailure }> {
  const result = await unwrapAndVerify(event, signer, { maxAgeSeconds: Infinity })

  if (!result.ok) {
    return { failure: { reason: result.reason, routine: result.reason === 'not-for-us' } }
  }

  const { seal, rumor } = result

  try {
    const parsed = await parseRfc2822(rumor.content)

    // Trust rule 5: RFC 2822 From is only authoritative when the bridge
    // sealed the message. Any other sealer could put anything in that header,
    // so the sender is the sealing key itself.
    const bridgeSealed = bridgePubkey !== null && seal.pubkey === bridgePubkey
    const fromAddress = bridgeSealed
      ? parsed.from?.address ?? seal.pubkey
      : seal.pubkey

    const toDisplay = (a: { name?: string; address?: string }) => ({
      name: a.address ? a.name : undefined,
      address: a.address || a.name || '',
    })

    const ccAddresses = (parsed.cc ?? []).map(toDisplay)

    return {
      email: {
        id: event.id,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references?.split(/\s+/).filter(Boolean),
        from: { name: bridgeSealed ? parsed.from?.name : undefined, address: fromAddress },
        to: (parsed.to ?? []).map(toDisplay),
        cc: ccAddresses.length ? ccAddresses : undefined,
        subject: parsed.subject ?? '(no subject)',
        body: parsed.text ?? '',
        bodyHtml: parsed.html ?? undefined,
        // Attachments are out of scope (§10); surface their presence rather
        // than dropping them silently.
        attachments: (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? 'attachment',
          contentType: a.mimeType ?? 'application/octet-stream',
          size: 0,
          data: undefined,
        })),
        timestamp: rumor.created_at,
        senderPubkey: seal.pubkey,
        read: false,
        labelEventIds: [],
        labels: [],
      },
    }
  } catch (err) {
    return { failure: { reason: `rfc2822 parse failed: ${(err as Error).message}`, routine: false } }
  }
}
```

- [ ] **Step 5: Update `useInbox` to the new shapes**

In `client/src/hooks/useInbox.ts`, replace the `decodeGiftWrap` call site:

```ts
        void decodeGiftWrap(event, signer, bridgePubkey)
          .then((outcome) => {
            if (!alive) return
            if ('email' in outcome) {
              addEmail(outcome.email)
              return
            }
            // Routine: relays deliver every wrap p-tagged to us, most of
            // which are not ours to read. Only shout about the rest (§8).
            if (outcome.failure.routine) return
            undecodable += 1
            console.warn(
              `[inbox] rejected wrap ${event.id.slice(0, 8)}: ${outcome.failure.reason} ` +
                `(${undecodable} so far)`,
            )
          })
```

Replace the signer construction with `protocolSigner(active)` and read
`bridgePubkey` from the settings store. Import `protocolSigner` from
`@/lib/nostr/protocol-signer`.

- [ ] **Step 6: Trim `giftwrap.ts`**

Delete `buildMailRumor`, `giftWrap`, `unwrapGiftWrap`, and `randomTimestamp`
from `client/src/lib/nostr/giftwrap.ts` — the protocol module owns them now.
Keep only `pubkeyToNpub` and `npubToPubkey`. Update every importer.

- [ ] **Step 7: Run tests, typecheck, build**

Run: `cd client && pnpm test && npx tsc --noEmit -p tsconfig.app.json && npx vite build`
Expected: all tests pass; no typecheck output; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add client/src
git commit -m "Rewrite client send and receive on the shared protocol

Adds the missing kind-13 seal, sends one bridge wrap for all legacy
recipients, and only trusts RFC 2822 From when the bridge sealed the
message."
```

---

### Task 10: End-to-end suite on real code paths

Deletes the e2e suite's private wrap builder so the tests exercise the same protocol module the apps do (Known-broken 10), and adds the regression tests for the bugs this plan fixes.

**Files:**
- Modify: `e2e-nostr/src/nostr-helper.ts`, `e2e-nostr/vitest.config.ts`, `e2e-nostr/src/test-outbound.test.ts`, `e2e-nostr/src/test-inbound.test.ts`
- Create: `e2e-nostr/src/test-security.test.ts`

**Interfaces:**
- Consumes: everything from `@nostr-bridge/protocol/index.js`.
- Produces: no new exports; `buildMailGiftWrap` is deleted.

- [ ] **Step 1: Delete the duplicate implementation**

Remove `buildMailGiftWrap` from `e2e-nostr/src/nostr-helper.ts` entirely
(lines 64-85 and any now-unused imports). Keep `publishToRelay` and
`waitForGiftWrap`.

- [ ] **Step 2: Point every call site at the protocol module**

In `e2e-nostr/src/test-outbound.test.ts`, replace the import:

```ts
import { buildMailRumor, sealAndWrap, keySigner } from "@nostr-bridge/protocol/index.js";
```

and replace each `buildMailGiftWrap(rfc2822, senderSk, bridgePubkey, extraTags)`
call with:

```ts
const signer = keySigner(senderSk);
const rumor = buildMailRumor({
  senderPubkey: await signer.getPublicKey(),
  recipientPubkey: env.bridgePubkey,
  rfc2822,
  deliverTo: [recipientAddress],
});
const wrap = await sealAndWrap(rumor, env.bridgePubkey, signer);
```

`recipientAddress` is the external mailbox each test already targets. The
`deliverTo` argument is now what routes the message — the bridge no longer
reads `To:`.

In `e2e-nostr/src/test-inbound.test.ts`, replace `unwrapEvent` from
`nostr-tools/nip59` with:

```ts
import { unwrapAndVerify, keySigner } from "@nostr-bridge/protocol/index.js";
```

and each unwrap with:

```ts
const result = await unwrapAndVerify(wrap, keySigner(recipientSk), { maxAgeSeconds: Infinity });
expect(result.ok).toBe(true);
if (!result.ok) throw new Error(result.reason);
```

Inbound assertions must now check for **full RFC 2822**, not
`Subject: …\n\n`. Assert the original `From:` header survives:

```ts
expect(result.rumor.content).toContain("From: ");
expect(result.rumor.content).toContain(senderAddress);
```

- [ ] **Step 3: Add the security regression test**

Create `e2e-nostr/src/test-security.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, getEventHash } from "nostr-tools/pure";
import { keySigner, sealAndWrap, unwrapAndVerify, KIND_MAIL } from "@nostr-bridge/protocol/index.js";
import { authorizeSender } from "@nostr-bridge/outbound.js";

describe("sender spoofing", () => {
  // The bridge must never send mail as a user who did not seal the message.
  it("an author-mismatch rumor never reaches authorization", async () => {
    const bridgeSk = generateSecretKey();
    const aliceSk = generateSecretKey();
    const mallorySk = generateSecretKey();
    const alicePk = getPublicKey(aliceSk);
    const bridgePk = getPublicKey(bridgeSk);

    const forged: any = {
      kind: KIND_MAIL,
      pubkey: alicePk,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", bridgePk], ["deliver", "victim@example.com"]],
      content: "From: alice@mailstr.app\r\nTo: victim@example.com\r\n\r\nsend money",
    };
    forged.id = getEventHash(forged);

    const wrap = await sealAndWrap(forged, bridgePk, keySigner(mallorySk));
    const result = await unwrapAndVerify(wrap, keySigner(bridgeSk));

    expect(result).toEqual({ ok: false, reason: "author-mismatch" });
  });

  it("authorization refuses a From the sealer does not own", async () => {
    const alicePk = "a".repeat(64);
    const malloryPk = "b".repeat(64);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ names: { alice: alicePk } }))) as typeof fetch;

    const result = await authorizeSender({
      from: "alice@mailstr.app",
      sealPubkey: malloryPk,
      localDomains: ["mailstr.app"],
    });

    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests that need no mail infrastructure**

Run: `cd e2e-nostr && npx vitest run src/test-security.test.ts src/test-attachment-utils.test.ts`
Expected: PASS. These need no mailcow.

- [ ] **Step 5: Run the full suite against live infrastructure**

This requires a running mailcow and a bridge configured with
`LOCAL_DOMAINS` and `NIP05_BASE_URL` pointing at the mock NIP-05 server.

Run: `cd e2e-nostr && pnpm test`
Expected: inbound and outbound suites pass. If mailcow is unavailable, record
that these were not run — do **not** report the suite as passing.

- [ ] **Step 6: Commit**

```bash
git add e2e-nostr
git commit -m "Run e2e against the shared protocol module

Deletes the suite's private gift-wrap builder, which is why it passed while
the real client could not talk to the bridge. Adds spoofing regression tests."
```

---

### Task 11: Live verification

The §Definition-of-done gate. No code changes — this is the evidence step, and the plan is not complete without it.

**Files:** none.

- [ ] **Step 1: Deploy the bridge with a known key**

Generate and record an nsec, set `LOCAL_DOMAINS=mailstr.app`,
`BRIDGE_RELAYS`, and `NIP05_BASE_URL`. Start the bridge and record the npub
it logs.

Confirm `mailstr.app/.well-known/nostr.json?name=_smtp` returns that same
pubkey. If it does not, the `_smtp` record must be updated before clients can
find the bridge.

- [ ] **Step 2: Confirm each done-criterion, recording the evidence**

- [ ] Client sends to an external address; it arrives in that real mailbox.
      Record the received headers and confirm SPF and DKIM pass.
- [ ] Reply from that external mailbox; it appears in the client with the
      correct `From`, and replying to it works.
- [ ] mailstr → mailstr send: confirm in the bridge log that nothing arrived
      there, and the message still lands in the recipient's client.
- [ ] Spoofing attempt: publish an author-mismatch wrap; confirm the bridge
      logs `author-mismatch` and sends no mail.
- [ ] Multi-recipient legacy send to three addresses; confirm each receives
      exactly one copy.

- [ ] **Step 3: Record the outcome**

Append a "Verified" section to `docs/ARCHITECTURE.md` listing which criteria
passed, with dates. State plainly anything not exercised. Do not mark a
criterion passed on the strength of a relay accepting an event — that is the
mistake this plan exists to correct.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "Record end-to-end verification results"
```

---

## Self-Review

**Spec coverage.** §1 wire choice → Tasks 1-2. §2 components → Tasks 4-9. §3
identity/normalization → Task 1 (`address.ts`), Task 3 (lookup), Task 5
(authorization). §4 wire format and the five rules → Task 2; `deliver`
tags → Tasks 2, 5, 9; size ceiling → constant in Task 1, enforcement deferred
with attachments (§10). §5 trust model → Tasks 2, 5, 9 (rule 5 in
`receive.ts`). §6A → Task 4; §6B → Task 5; bounces → Task 5;
self-publication → Task 6. §7 resolution → Task 8. §8 failure taxonomy →
`UnwrapFailure` in Task 1, applied in Tasks 5 and 9. §9 shared module →
Tasks 1-2, wired in Task 7. §10 out-of-scope respected: no Blossom work; §11
cost documented, batching not implemented. Definition of done → Task 11.

**Known gap:** §4's size ceiling is defined as `MAX_PLAINTEXT_BYTES` but never
enforced — a >64KB body will fail inside `nip44.encrypt` with a raw library
error rather than a friendly message. Acceptable while attachments are out of
scope, since a text body that large is rare; worth a guard when attachments
land.

**Placeholders:** none. Every code step contains complete code. Task 11 is
deliberately a verification checklist, not an implementation task.

**Type consistency:** `ProtocolSigner`, `Rumor`, `UnwrapResult` and
`UnwrapFailure` are defined in Task 1 and used unchanged in Tasks 2, 4, 5, 7,
9, 10. `buildMailRumor`/`sealAndWrap`/`unwrapAndVerify`/`deliverTargets`
signatures are fixed in Task 2 and matched at every later call site.
`lookupNip05` returns `Nip05Result` from Task 3, consumed in Tasks 4 and 5.
`resolveRecipients`/`ResolveContext`/`ResolveOutcome` are defined in Task 8
and consumed in Task 9. `decodeGiftWrap` changes shape in Task 9 and its only
caller (`useInbox`) is updated in the same task.
