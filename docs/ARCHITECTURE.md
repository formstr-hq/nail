# mailstr — architecture and protocol

Single source of truth for the mailstr client, landing page, and Nostr bridge.

**Status: 2026-07-21.** The design below is implemented. Every item in the
[Known-broken inventory](#known-broken-inventory) has been fixed, plus several
found during implementation. What that does and does not prove is set out under
[Verification](#verification) — in short, the protocol is proven by tests, and
end-to-end delivery against real mailboxes is **not yet run**.

> **The deployed bridge still runs the old code**, so none of the outbound
> authorization described here is in force in production. Until it is
> redeployed, any account can send as any address on the local domain — fully
> SPF/DKIM/DMARC-aligned. See
> [Live-deployment gap](#live-deployment-gap-as-of-2026-07-21) for the stopgap.

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
| formstr API | External (`api.formstr.app`) | Name purchase and ownership lookup. NIP-98 authed. **Not in the mail path.** |
| NIP-05 record | External (`mailstr.app/.well-known/nostr.json`) | Public name→pubkey map. **In the mail path.** |

```
  mailcow/Postfix ──LMTP──► nostr-bridge ──relays──► client
        ▲                        │                     │
        └────────SMTP────────────┘◄────gift wrap───────┘
```

### Two backend surfaces — keep them distinct

| | `api.formstr.app` | `mailstr.app/.well-known/nostr.json` |
|---|---|---|
| Auth | NIP-98 signed requests | none, public |
| Callers | `client/`, `landing/` — browsers only | `client/`, `landing/`, **`nostr-bridge/`** |
| Mail path | no | **yes — hard dependency** |

Verified 2026-07-20: these are different hosts.
`api.formstr.app/.well-known/nostr.json` returns **404**; the record is served
from `mailstr.app` (Express behind Cloudflare, `vary: Origin`, so browser-usable).

`api.formstr.app` has exactly three call sites, all account management:
`POST /api/generate-invoice/mail` (landing, name purchase, plus a websocket for
payment status), `GET /api/nip-05/get-nip05` (client, NIP-98 authed, lists
owned names for the sender picker), and the base-URL default in each app's
`config.ts` (`VITE_API_BASE_URL` overrides). **`nostr-bridge/` never calls it.**

This is a property worth preserving: the bridge's entire authorization model
(§5) rests on a *public* record, so it holds no credentials, needs no database,
and has no privileged relationship with the backend. Moving authorization to
the authed API would give the bridge a secret to store and an outage mode it
cannot diagnose.

Availability follows from this split: outbound mail stops if **`mailstr.app`**
is down. If `api.formstr.app` is down, signup and the sender picker break but
mail keeps flowing.

#### Reaching the API in development

`api.formstr.app` allows a fixed set of origins and answers any other with a
**500**, not a CORS rejection (verified 2026-07-21: no `Origin` → 401,
`https://mailstr.app` → 401, `http://localhost:5173` → 500). A browser on
localhost therefore cannot call it directly, and the failure looks like a
server error rather than the CORS problem it is.

Dev builds so issue same-origin requests that Vite's `/api` proxy forwards
upstream, stripping the `Origin` and `Referer` headers that trigger the 500.
Production builds call the API directly from an allowlisted origin.

That split forces one subtlety: **NIP-98 signs the URL the server sees, not the
one the browser requested.** The `u` tag must match the upstream URL or the
backend 401s in dev only. Hence two helpers — `apiUrl()` decides where to send,
`apiAuthUrl()` decides what to sign.

The proper fix belongs upstream: the backend should return a real CORS
rejection instead of a 500, and allowlist localhost so this proxy is
unnecessary.

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
5. RFC 2822 `From:` is authoritative **only where the claim is backed by
   something**. Three cases qualify, and nothing else does:
   - `seal.pubkey` is the configured bridge — the bridge already refused to
     relay a `From` the sending key does not own (§5);
   - `seal.pubkey` is the reader's own key — their own outgoing copy;
   - the address's NIP-05 record resolves to `seal.pubkey` — the same proof
     the bridge performs, done client-side.

   For any other sealer the sender is `seal.pubkey` and the headers are
   decoration. An unverified sender is displayed as the **npub**, labelled
   with the kind-0 profile name when one exists. That name is self-asserted —
   anyone may publish `name: "Your Bank"` — so it never replaces the npub,
   only accompanies it. Substituting it outright would make spoofing
   invisible; showing it alongside a key the reader can check does not.

### Envelope versus headers

These are distinct, as in SMTP:

- **Headers** (`To:`, `CC:`) — what recipients see. Always complete.
- **`deliver` tags** — the envelope for *this hop*. Who the bridge must deliver
  to, and nobody else.

One gift wrap goes to the bridge regardless of how many legacy recipients there
are; their addresses are `deliver` tags. Recipients who received a direct Nostr
copy never appear in a `deliver` tag, so they are not also emailed.

### Content is a byte string

`rumor.content` is the RFC 2822 message as a **byte string**: a JS string in
which every code unit is one octet (0–255) of the original message. Each end
converts at its boundary — bytes in on receive, bytes out on send.

This is not incidental. Mail is bytes, not text: a message declares its own
charset in `Content-Type`, and legacy senders still emit ISO-8859-1, Shift-JIS
and other 8-bit encodings. Decoding those bytes as UTF-8 to carry them as text
destroys them. Verified against the real parser:

```
utf8 decode          → "caf�"   replacement char, unrecoverable
latin1 decode        → "cafÃ©"       bytes survive transport, but postal-mime
                                     re-encodes string input to UTF-8 and mojibakes
byte string → bytes  → "café"        correct
```

The second line is the trap: preserving the bytes in transit is not enough,
because `postal-mime` given a *string* encodes it to UTF-8 before applying the
declared charset. The parser must be handed a `Uint8Array`.

The protocol module owns both conversions so all three consumers share one
implementation. Round-trip is exact for ISO-8859-1, UTF-8 and Shift-JIS
inbound, and byte-identical for client-composed outbound mail.

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

### The client's `From` check is a guard, not a boundary

The client refuses to send from an address the signing key does not own,
applying the same NIP-05-resolves-to-sender test the bridge does — kept
identical on purpose, so the two cannot diverge into silent bounces or false
confidence. `<npub>@<domain>` is proven locally from the key itself and needs
no lookup.

This is a UX guard. A modified client skips it in one line. The enforcement
that matters is the bridge checking `seal.pubkey`, which an attacker cannot
route around.

### Why the open-relay default was worse than it looked

`ALLOWED_DOMAINS` defaulting to empty skipped every sender check, and on a
domain that publishes SPF, DKIM and DMARC the result is not merely spam — it
is *authenticated* spam. Mail sent as `support@<local domain>` from the
domain's own MX passes all three checks and lands in the inbox, carrying the
domain's real reputation. That is a phishing platform aimed at the
deployment's own users, which is strictly worse than an open relay that only
damages the sending IP.

Two properties made it latent rather than exploited: the old client never
produced a kind-13 seal, so nothing it sent could be unwrapped by the bridge
at all. Fixing the client is what made the pre-existing hole reachable — worth
remembering as a shape, since correcting one side of a broken protocol can
expose weaknesses the other side's brokenness was hiding.

**Operational corollary:** authority names (`admin`, `support`, `postmaster`,
`abuse`, `security`, `billing`, `noreply`) must be unregistrable in the
backend. Once ownership is enforced, whoever registers `support@<domain>`
becomes legitimately authorized to send as it.

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

### Resumed remote-signer sessions

A resumed NIP-46 session is a fourth silent failure, and it needs its own
handling because the obvious health check does not work.

`unlock()` reconstructs the bunker signer with the stored pubkey as
`cachedUserPubkey`, so `getPublicKey()` answers from memory rather than the
bunker. Probing it proves nothing — it compares the cached value with itself
and can never fail. It catches a broken *extension*, but for a bunker it is
dead code.

`unlock()` also, deliberately, skips the NIP-46 `connect` request, because
re-sending it prompts the user for approval on every cold start. But `connect`
is what establishes the subscription that bunker responses arrive on. Without
it the first `sendRequest` calls `setupSubscription()` and publishes without
awaiting it, so the relay often has no live subscription when the bunker
answers and the reply is dropped. `sendRequest` has no timeout of its own, so
that request hangs until the app's own ceiling fires — the observed signature
is several failures at exactly the ceiling followed by successes in ~1s.

So resume issues one real round trip (`nip44Encrypt` to self), with one retry.
The retry is the fix rather than a workaround: the first attempt is what warms
the subscription, and losing it is expected. A session that fails both attempts
is treated as dead and the user is returned to login, which is what they would
otherwise achieve by logging out and back in.

The proper fix belongs upstream — `unlock()` should await subscription setup
before returning, so callers do not each have to warm it.

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

## Verification

As of 2026-07-21. Stated precisely, because the failure this rebuild exists to
correct was believing "published to a relay" meant "delivered".

**Verified by automated tests** — `nostr-bridge` 64, `client` 15, `e2e-nostr`
13 (the infrastructure-free subset); all three packages typecheck and the
client bundles the shared protocol module for the browser.

- Client and bridge interoperate: both build and consume wraps through the one
  `protocol/` module, so the format mismatch cannot recur by construction.
- The spoofing attack is rejected (`author-mismatch`), and authorization is
  taken from `seal.pubkey`, never `rumor.pubkey`.
- A sender may only use a `From` address whose NIP-05 record matches the
  sealing key; every failure path, including lookup errors, fails closed.
- One wrap carries N legacy recipients as `deliver` tags; the bridge emits one
  message with N envelope recipients.
- The bridge refuses to relay into its own domains.
- Inbound mail keeps the original RFC 2822 bytes exactly, verified for
  ISO-8859-1, UTF-8 and Shift-JIS.
- SMTP status discipline: unregistered name → 550, lookup error → 451, no
  relay accepted → 451 and never 250.
- mailstr-to-mailstr resolves via NIP-05 and produces no bridge wrap.
- The client refuses to send from an address the signing key does not own —
  covering an unregistered authority name and another user's registered name.

Verified by hand against live infrastructure, not by tests:

- `mailstr.app` DNS is sound for outbound: `MX → mail.formstr.app`,
  `v=spf1 mx ~all`, a `dkim._domainkey` RSA key, and DMARC `p=quarantine` with
  relaxed alignment. A `From` inside the domain, sent from its own MX, aligns
  on SPF, DKIM and DMARC.
- `api.formstr.app` accepts our NIP-98 header (a signed request from an
  unregistered key returns 404, not 401) and scopes results to the signing
  key — the endpoint takes no npub parameter, so one account cannot read
  another's addresses.
- The dev proxy reaches the real API (401 without auth, rather than the 500 a
  direct localhost call produces).

**Not yet exercised** — these need a deployed bridge and real mailboxes:

1. A message from the client arriving in a real external mailbox with SPF and
   DKIM aligned.
2. A reply from that external mailbox arriving in the client, and being
   replyable.
3. The `e2e-nostr` inbound/outbound suites, which require a live mailcow.
4. The deployed `_smtp@mailstr.app` pubkey being one whose key we hold.
5. Attachments, which remain out of scope (§10).

Until 1 and 2 are done, this system is **not proven to deliver mail**.

### Fixed during implementation, beyond the original inventory

- **The bridge's relay subscription used `since: now`.** NIP-59 randomises a
  gift wrap's `created_at` up to two days into the past and relays filter on
  that outer timestamp, so relays would have withheld essentially every wrap
  addressed to the bridge. The e2e suite had been papering over this with its
  own `created_at = now()` builder — the same duplicate implementation that hid
  the format mismatch.
- **Content was decoded as UTF-8**, destroying non-UTF-8 mail. See §4.
- **The heartbeat watchdog was lost** in the outbound rewrite and has been
  restored: a relay subscription can die silently, leaving the bridge accepting
  no mail while appearing healthy.
- **`docker-compose.bridge.yml` lacked `LOCAL_DOMAINS`**, which is now required
  at boot, so the bridge would have crash-looped.
- **The client called `localhost:5000`** for owned-address lookup, because that
  was the dev default and `.env.local` is gitignored. Repointing it alone does
  not work — see "Reaching the API in development" (§2).
- **Resumed bunker sessions hung** on their first requests. See §8.
- **Unverified senders rendered as raw hex pubkeys**, including the user's own
  outgoing copies, because rule 5 recognised only the bridge. See §4 rule 5.

### Live-deployment gap (as of 2026-07-21)

The deployed bridge behind `_smtp@mailstr.app` (`23024bfd…`) still runs the
**old** code: a query for its kind-0 and kind-10050 returns zero events, which
the new code publishes at startup. Consequences while that remains true:

- Nothing written here about outbound authorization is in force in production.
  `ALLOWED_DOMAINS` is unset there, so the old code skips every sender check —
  confirmed by sending as an unowned `hi@mailstr.app`, which was relayed.
- Setting `ALLOWED_DOMAINS=<local domain>` on the old code is a valid stopgap:
  it enables the domain allowlist and NIP-05 match, and blocks both an
  unregistered name and another user's name. It compares the forgeable
  `rumor.pubkey`, so it stops casual misuse but not a deliberate attacker.
- The new client and the old bridge *do* interoperate, since the old bridge
  always expected a correct three-layer wrap. That is precisely why the hole
  became reachable.

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
7. A send as an address the account does not own is refused — both an
   unregistered authority name and another user's registered name.
8. The deployed bridge logs its npub on boot, and `_smtp@<domain>` resolves to
   that same key.

Items 3, 4, 5, 6 and 7 are met. Items 1, 2 and 8 need a deployed bridge and
real mailboxes, and are the whole of what stands between here and "this
delivers mail".
