# mailstr — architecture and protocol

Single source of truth for the mailstr client, landing page, and Nostr bridge.

**Status: 2026-07-20.** This document describes a *target* design. The system as
committed does not deliver mail in either direction — see
[Known-broken inventory](#known-broken-inventory) for the evidence. Where the
current code and this document disagree, this document is the intent and the
code is wrong.

---

## 1. What mailstr is

Email, transported over Nostr. The payload is always a complete RFC 2822
document. Nostr provides encrypted, relay-based delivery; RFC 2822 provides
identity, threading, and interoperability with the existing email world.

This choice is deliberate and has a cost: mailstr messages use kind `1301`,
which generic Nostr DM clients (Damus, Amethyst) do not render. mailstr is its
own ecosystem that gateways to email, not a NIP-17 chat client.

The alternative — mapping mail onto NIP-17 kind `14` — was rejected because
kind 14 has no headers. That is not a theoretical loss: it is exactly what
discards the sender address on inbound mail today, making replies to external
correspondents structurally impossible.

## 2. Components

| Component | Runtime | Role |
|---|---|---|
| `client/` | Browser (React, Vite) | Webmail UI. Holds the user's key via `@formstr/signer`. |
| `landing/` | Browser (React, Vite) | Signup and name registration. Not in the mail path. |
| `nostr-bridge/` | Node, sidecar to mailcow | Translates between SMTP and Nostr. The only trusted component. |
| `e2e-nostr/` | Vitest | End-to-end suite against a mock relay and a real mailcow. |
| formstr-backend | External (`api.formstr.app`) | Name registration; serves `mailstr.app/.well-known/nostr.json`. |

```
  mailcow/Postfix ──LMTP──► nostr-bridge ──relays──► client
        ▲                        │                     │
        └────────SMTP────────────┘◄────gift wrap───────┘
```

The backend is **not** in the mail path. Both bridge and client read its
NIP-05 record as a public, unauthenticated source. No mail flows through it.

## 3. Identity and addressing

**Local domains** are the domains this deployment accepts mail for and serves
NIP-05 records for — `mailstr.app` in production, configured per deployment.
The term is used throughout as `ctx.localDomains`. Every other domain is
**legacy** and reachable only through the bridge.

An address is `<name>@<domain>`. Ownership of `name@mailstr.app` is established
by two independent facts:

1. **Key possession** — a valid kind-13 seal proves the sender holds the private
   key for `seal.pubkey`.
2. **Assignment** — `GET https://mailstr.app/.well-known/nostr.json?name=<name>`
   returns the pubkey the backend assigned to that name.

If they match, the holder owns the address. The bridge needs no database and no
authentication to check this.

Normalization before lookup, both directions:

- Lowercase the localpart. SMTP treats `Xyz@` and `xyz@` as one mailbox; NIP-05
  lookup is exact string match.
- Strip `+tag` subaddressing. `xyz+news@` authorizes against `xyz`.

Nostr-native recipients with no email address are written into headers as
`<npub>@<localDomain>`, which is a valid RFC 2822 addr-spec. A bare `npub1…` in
a `To:` header parses as a display *name* with an empty address, which renders
as a blank recipient.

## 4. Wire protocol

Identical in both directions.

```
kind 1059  gift wrap    ephemeral key; tags: [["p", recipient]]
                        created_at randomized up to 2 days in the past
  └ kind 13  seal       signed by the true sender's key
                        content: nip44(rumor, convKey(sender, recipient))
      └ kind 1301 rumor UNSIGNED. pubkey = true sender.
                        created_at = now (the canonical timestamp)
                        tags: [["p", recipient], ["deliver", addr]…]
                        content: full RFC 2822 document
```

The kind-13 seal is **mandatory**. NIP-59 does not make it optional, and every
trust decision in this system keys off `seal.pubkey`.

### Verification rules — all mandatory

On receipt, in order:

1. `verifyEvent(seal)` — the seal's signature must be valid.
2. `seal.kind === 13`.
3. **`rumor.pubkey === seal.pubkey`.** See [§5](#5-trust-model).
4. `rumor.kind === 1301`.
5. RFC 2822 `From:` is authoritative **only if `seal.pubkey` equals the
   configured bridge pubkey**. For any other sealer, the sender is
   `seal.pubkey` and the headers are decoration.

### Envelope versus headers

These are distinct, as in SMTP:

- **Headers** (`To:`, `CC:`) — what recipients see. Always complete.
- **`deliver` tags** — the envelope for *this hop*. Who the bridge must deliver
  to, and nobody else.

One gift wrap goes to the bridge regardless of how many legacy recipients there
are; their addresses are `deliver` tags. Recipients who received a direct Nostr
copy never appear in a `deliver` tag, so they are not also emailed.

### Size ceiling

NIP-44 v2 caps plaintext at **65535 bytes**. Base64 inflates attachments ~33%,
so inline MIME attachments fail above roughly **40 KB of file**. Attachments
therefore require Blossom offload with `imeta` tags. **Out of scope for this
pass** — see [§10](#10-out-of-scope).

## 5. Trust model

**`nostr-bridge` is the only trusted component.** It enforces two rules:
inbound, the recipient must be a registered name; outbound, the sealer must own
the `From` address.

**The client is untrusted by the bridge.** The bridge authorizes against
`seal.pubkey` only.

**The bridge is conditionally trusted by the client**, per verification rule 5.

### Why rule 3 exists

`unwrapEvent()` in nostr-tools discards the seal and returns only the rumor, and
never checks that the rumor's `pubkey` matches the seal's. Verified by
experiment:

```
seal signed by      : 65e2d74c… (attacker)
rumor claims pubkey : 343ab596… (alice)
nostr-tools checked rumor==seal?  NO
VERDICT: ACCEPTED — mail sent as Alice
```

An attacker seals with a key they legitimately hold while setting
`rumor.pubkey` to the victim's. Any code authorizing against `rumor.pubkey`
sends mail as the victim.

**Consequence: `unwrapEvent` must not be used.** The protocol module provides
its own unwrap returning `{ seal, rumor }` so rules 1–3 are checkable.

### Authorization caching

The NIP-05 result used for *authorization* is cached for at most ~60s, or not
at all. A long positive cache lets a former owner keep sending as a transferred
name. This is separate from the recipient-probe cache in §7, which may be
long-lived because its worst failure is a routing detour.

`mailstr.app/.well-known/nostr.json` is therefore a **hard dependency of
sending**. Backend outage stops outbound mail. That is correct fail-closed
behaviour, and bounces must say so specifically.

## 6. Pipelines

### A. Inbound — SMTP → Nostr

1. Postfix delivers over LMTP with `rcptTo = alice@mailstr.app`.
2. Normalize localpart (§3), NIP-05 lookup.
   - Unknown name → **550 permanent**, so Postfix bounces to the real sender.
   - Lookup *error* → **451 temporary**, so it retries. Do not conflate these.
3. Build rumor kind 1301, `pubkey = bridgePubkey`, content = **the original
   RFC 2822 byte-for-byte**. No reconstruction. Headers survive, so `From`,
   `Message-ID` and `References` survive, so replies and threading work.
4. Seal with the bridge key, wrap with an ephemeral key.
5. Publish to the recipient's **kind 10050** DM relays. NIP-17: *"Clients MUST
   only publish events to the relays listed in the recipient's kind 10050
   event."* Fall back to bridge defaults only if the recipient published none.
6. If no relay accepted the event, return **451**. Never `250` a message that
   went nowhere — `250` tells the peer it was delivered, and it is then gone.

### B. Outbound — Nostr → SMTP

1. Subscribe `{kinds:[1059], "#p":[bridgePubkey]}` on the bridge's own 10050
   relays.
2. Unwrap to `{seal, rumor}`; apply verification rules 1–4. Failure → drop and
   log with a reason.
3. Authorize: parse `From`, normalize, require a local domain, NIP-05 lookup,
   require the result to equal **`seal.pubkey`**. Failure → bounce.
4. Envelope from `deliver` tags, never from `To:`. No tags → drop.
5. **Reject `deliver` targets on local domains.** Otherwise the bridge can be
   used to inject into local mailboxes while bypassing inbound rules. Local
   recipients are reachable directly over Nostr.
6. Inject once with `MAIL FROM` = the verified address and `RCPT TO` = the
   deliver list. Postfix applies SPF/DKIM for the aligned domain.
7. **Replay guard.** Relays replay stored events and a captured wrap can be
   re-published verbatim. Dedupe on rumor `id` *and* reject rumors whose
   `created_at` is older than a few minutes. An in-memory seen-set alone is not
   sufficient: it resets on restart and is bounded.

### Bounces

Delivered as a kind-1301 gift wrap sealed by the bridge, addressed to
`seal.pubkey`, carrying a real RFC 2822 delivery-status message. Because the
bridge sealed it, verification rule 5 renders it as a genuine bridge notice.

### Bridge self-publication

At startup the bridge publishes its own **kind 10050** (so clients know where to
send) and a **kind 0** with `nip05: _smtp@<domain>`, and logs its npub. Without
these, delivery depends on the accident that default relay lists overlap.

## 7. Recipient resolution (client)

```
resolve(address, ctx):
  1. npub or 64-hex            → nostr,  header = <npub>@<ctx.localDomain>
  2. no "@"                    → error, unresolvable
  3. localpart is an npub      → nostr,  header = address      (reply form)
  4. NIP-05 probe (1.5s, cached)
       hit                     → nostr,  header = address
       miss AND domain is one
         of ctx.localDomains   → error "no such mailbox"
       miss otherwise          → legacy, header = address
  5. legacy and no bridge      → error "no bridge configured"
```

**mailstr → mailstr never touches the bridge.** It resolves via NIP-05 and goes
direct. The bridge exists only for legacy domains.

Probe policy: probe every domain, bounded at ~1.5s, with a persistent cache.
Seed the negative cache with the large providers (gmail, outlook, yahoo, proton,
icloud) — same benefit as a routing blocklist, but a stale entry costs one probe
instead of permanently misrouting mail. Cache negatives ~24h, positives longer.
Timeout is fail-safe: treat as legacy and route to the bridge.

A maintained "known legacy domains" routing list was rejected: it can only ever
cover a handful of the thousands of real mail domains, so the general case pays
the probe anyway, and the cache already provides the win.

Send then produces: one wrap per Nostr recipient, **one** wrap to the bridge
carrying all legacy recipients as `deliver` tags, and one wrap to self (which
becomes the Sent entry).

### Bridge discovery

Default: `_smtp@<the user's own address domain>`, resolved via NIP-05 and
cached — mirroring SMTP, where your outgoing server is your mailbox provider's.
A Settings override exists for self-hosters. The `_smtp` record must be served
with permissive CORS.

## 8. Failure handling

Every failure in the current pipeline is silent, which is why these bugs
survived: a protocol mismatch, a wrong key, an unregistered name, and a network
blip all present as an empty inbox.

| Outcome | Example | Handling |
|---|---|---|
| Not ours | a wrap we cannot decrypt | Silent. Routine — relays send everyone's wraps. |
| Malformed | `rumor.pubkey ≠ seal.pubkey` | Drop, log with reason, **count**. Never silent. |
| Unauthorized | `From` not owned by sealer | Bounce with the specific reason. |
| Transient | relay refused, backend down | Retry; 451 on the SMTP side. |

Rows 1 and 2 must never be collapsed. Both are "couldn't read it", but the
first is normal and the second means something is broken.

## 9. Shared protocol module

Three implementations of this wire format exist today — `client/`,
`nostr-bridge/`, and `e2e-nostr/src/nostr-helper.ts` — and no two agree. Fixing
them independently leaves them free to drift again.

**One implementation**, owning rumor construction, seal, wrap, unwrap, and
verification rules 1–5. It takes an abstract signer so the browser backs it with
NIP-07/NIP-46 and the bridge with a raw key.

Built inside `nostr-bridge/` first and imported directly by the client;
promotion to a workspace package is deferred until the interface settles.

Because the client bundles it through Vite, the module must use **no Node
built-ins** — no `node:crypto`, no `Buffer`. Web Crypto and `Uint8Array` only,
with `nostr-tools` as the sole dependency. The bridge's existing
`node:crypto` usage stays outside the shared module.

## 10. Out of scope

- **Attachments.** Outbound has no compose UI and no Blossom upload; inbound
  `imeta` tags are dropped by the client. This pass gets text and HTML mail
  working end to end. Inbound attachments surface as
  "N attachments (not yet supported)" rather than vanishing silently. The
  §4 size ceiling is the constraint any later design must address.
- **Send-as-external-identity.** The bridge fails closed on `From`. Mailing-list
  style `From` rewriting is a separate feature needing its own abuse review.
- **Batching signer calls.** See §11.

## 11. Known costs

The seal must be signed by the *user's* key, so each recipient costs two signer
calls (`nip44Encrypt`, `signEvent`) instead of zero. On a NIP-46 bunker that is
two relay round-trips per recipient plus the self-copy — sending to five people
means twelve round-trips. Inherent to NIP-59, not to this design, but it makes
batching a requirement rather than a nicety.

## Known-broken inventory

Evidence gathered 2026-07-20 by executing the committed code, not by reading it.

1. **Client and bridge cannot exchange messages, either direction.**
   ```
   bridge unwrapEvent() on a client gift wrap → THREW: invalid payload length: 42
   client unwrapGiftWrap() on a bridge wrap   → kind 13 → DROPPED (returns null)
   ```
   The client emits a single-layer wrap with no kind-13 seal and kind 1301;
   the bridge emits full NIP-59 with kind 14. No mail has ever flowed end to
   end. Prior reports of a verified round-trip were verifying
   publish-to-relay, not delivery.

2. **Inbound mail loses the sender permanently.** `email-parser.ts:20` parses
   `from`; `nostr-publisher.ts:70-72` builds content as `Subject: …\n\n{text}`
   and drops it. Replying to external mail is impossible, not merely buggy.

3. **Replies have nowhere to land.** The bridge seals inbound with
   `deriveSecretKey(master, recipientPubkey)` — a per-*recipient* pseudonym, so
   every external correspondent looks identical to a given user. The listener
   subscribes only to `"#p":[bridgePubkey]`, so a reply to that pseudonym is
   never delivered to anything.

4. **Sender spoofing.** The bridge authorizes against `rumor.pubkey`
   (`nostr-listener.ts:229`), which is attacker-controlled. See §5.

5. **Sender verification is opt-in.** `ALLOWED_DOMAINS` defaults to empty and
   `nostr-listener.ts:212` then skips all checks — an open relay in the default
   configuration.

6. **Relay-list mismatch.** The client reads kind **10050** (`relays.ts:45`);
   the bridge publishes to kind **10002** write relays
   (`user-resolver.ts:38-55`). Even with the format fixed, inbound mail lands on
   relays the client never reads.

7. **Multi-recipient legacy mail is broken.** `send.ts:58` sends one wrap per
   recipient to the same bridge pubkey; `nostr-listener.ts:203-204` reads
   `parsed.to[0]` only. Recipient #1 gets three copies, #2 and #3 get none,
   legacy CC is dropped.

8. **The bridge publishes no kind 10050 and no kind 0.** Delivery relies on
   default relay lists happening to overlap.

9. **Pointless cross-origin probe.** `resolve.ts:50` fetches
   `https://gmail.com/.well-known/nostr.json` on every send: CORS failure,
   seconds of latency, then falls through to the bridge anyway.
   `isLegacyEmail` (`nip05.ts:21-27`) is a stub whose own comment says so.

10. **The e2e suite validates a client that does not exist.**
    `e2e-nostr/src/nostr-helper.ts:64-85` is a third implementation — correct
    three-layer NIP-59 with kind 1301 — used to build test messages instead of
    the client's own code. The suite passes against a real mailcow while the
    real client cannot talk to the bridge.

11. **Attachments are dropped inbound.** The bridge sends them as `imeta` tags;
    `receive.ts:44` reads only `parsed.attachments` from the RFC 2822 body.

## Definition of done

Not "published to a relay" — events published to relays nobody reads are
indistinguishable from success.

1. Real client code sends to `bob@gmail.com`; it arrives in a real mailbox with
   SPF/DKIM aligned.
2. A reply from that external mailbox arrives in the client with the correct
   `From`, and is itself replyable.
3. mailstr → mailstr never touches the bridge.
4. The §5 spoofing attempt is rejected and bounced.
5. A multi-recipient legacy send delivers one copy to each recipient.
6. e2e tests import client and bridge code paths; the helper implementation is
   deleted.
