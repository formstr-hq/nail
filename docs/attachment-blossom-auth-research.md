# Attachment upload authorization — research

**Question:** the bridge must upload attachments to Blossom on a user's behalf, but it
never holds the user's private key. Can a NIP-44 conversation key be turned into an
upload keypair that *both* the bridge and the user can compute? Is there any way to
get the shared secret out of a signer? And what else could work?

**Constraint (2026-08-13):** users may use Blossom servers we do not control, so
nothing here may depend on modifying the server. That rules out server-side owner
mapping and confines us to standard BUD behaviour.

Code references are to this repo and to `nostr-storage-orchestrator`.

---

## 1. What the attachment path already is

`nostr-bridge/src/blossom-client.ts` already:

- encrypts each attachment with **AES-256-GCM under a fresh random 32-byte key**,
- uploads the *ciphertext*,
- returns `{url, sha256, encryptionKey, decryptionNonce}`, which
  `nostr-publisher.ts` puts in a NIP-92 `imeta` tag inside the gift-wrapped mail
  event.

`uploadEncryptedAttachment(plaintext, derivedSecretKey, url)` already takes the
signing key as a parameter and **has no caller today** — outbound attachments are
out of scope in the rebuild plan (§10), and `derivedSecretKey` is the residue of
Step 7, which deleted `key-derivation.ts`. `BLOSSOM_THRESHOLD_BYTES`
(`client/src/lib/nostr/constants.ts:24`) is declared and unused.

**Consequence that shapes everything below:** blob *confidentiality* does not depend
on Blossom auth at all. The blob is already ciphertext and the key travels inside the
gift wrap. The Blossom auth key only decides who may upload, whose quota is charged,
and who may `list`/`delete`.

And of those three, **only `delete` genuinely requires the owner key.** Listing does
not: [BUD-12](https://github.com/hzrd149/blossom/blob/master/buds/12.md) marks
`/list/<pubkey>` optional and explicitly "not recommended for implementation", so an
attachment manager cannot rely on it against arbitrary servers anyway — it has to
build its index from the `imeta` tags in the user's own mail store. So the entire
key-sharing question reduces to: *who can delete.*

## 2. Can the shared secret be extracted from a signer? No.

This is the complete surface. There is no method anywhere that returns a shared
secret, and no path that reconstructs one.

| Method | Available on | Deterministic? | Yields the secret? |
|---|---|---|---|
| `get_public_key` | all | yes | no |
| `sign_event` | all | **no** — BIP-340 uses random aux data | no |
| `nip44_encrypt` | all | **no** — random 32-byte nonce | no |
| `nip44_decrypt` | all | yes | no — see below |
| `nip04_encrypt` | most (deprecated) | no — random IV | no |
| `nip04_decrypt` | most (deprecated) | yes | theoretically, unusably — see below |

[NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) defines exactly
`getPublicKey`, `signEvent`, `nip04.{encrypt,decrypt}`, `nip44.{encrypt,decrypt}`.
[NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) adds only
`connect`, `ping`, `logout`, `switch_relays`. NIP-55/Amber mirrors the same surface.
No `getSharedSecret`, no `get_conversation_key`, in any of them. In this repo, only
`common-packages/packages/signer/src/core/localSigner.ts:39` can reach it, because
it holds the raw key.

**`nip44_decrypt` is deterministic but is a delivery channel, not an extraction
channel.** You cannot construct a ciphertext that decrypts to something you don't
already know: NIP-44 v2 MACs the payload under the conversation key, so a forged
input is rejected. It lets someone who *has* the secret hand you a value; it does not
let you compute one.

**`nip04_decrypt` is the one genuinely interesting path, and it still fails.**
[NIP-04](https://github.com/nostr-protocol/nips/blob/master/04.md) is unusual:
*"only the X coordinate of the shared point is used as the secret and it is NOT
hashed"* — the AES-256-CBC key **is** the raw ECDH `shared_x`, and CBC has no MAC.
That makes `nip04_decrypt` an unauthenticated decryption oracle over precisely the
secret we want. Three things kill it:

1. **PKCS#7.** `decipher.final()` throws unless the last block has valid padding.
   For a random block that is ≈0.4%, so recovering one value costs ~256 signer
   calls — each one an Amber prompt or a bunker round trip.
2. **Lossy UTF-8 on the return path.** The oracle returns a *string*. Invalid byte
   sequences become U+FFFD rather than throwing, so most of the entropy in a block
   that does survive padding is destroyed before it reaches the caller.
3. **NIP-04 is deprecated** and increasingly not implemented at all.

The only way to make it one call is for the **bridge** to search offline (it has
`shared_x`) for an `(IV, C)` pair that decrypts cleanly for that specific user, and
publish it. But that is a per-user datum delivered bridge→user — which is exactly
what NIP-44 already gives you, authenticated and in one standard call.

**That is the real conclusion of this section.** Every path that works at all
requires exactly one piece of bridge→user data. Once you concede that, the
conversation key has **no remaining advantage** — its only selling point was
zero-communication symmetry, and that is precisely what remote signers remove. So
do not derive from the conversation key. Deliver the upload key itself.

## 3. Option A — mirror-on-read with the user's real key (recommended)

This is the option that needs no shared secret at all, and the only one where the
user owns their attachments **under their actual npub** on servers you do not
control.

1. Bridge uploads the encrypted blob to **its own** Blossom server, signed with
   **its own** key. No derivation, no sharing, no `derivedSecretKey` parameter.
2. The `imeta` tag points at the bridge's URL, as it does today.
3. The client, on first read of that mail, fetches the user's kind **10063** server
   list ([BUD-03](https://github.com/hzrd149/blossom/blob/master/buds/03.md)) and
   calls `PUT /mirror {"url": "<bridge url>"}` on each server, authorized by a
   normal **`upload`** auth event carrying `["x", <sha256>]` — signed with the
   **user's real key**.
   [BUD-04](https://github.com/hzrd149/blossom/blob/master/buds/04.md) specifies
   that mirror reuses the upload token and that the destination server fetches the
   blob from the source URL itself, verifying the hash against the `x` tag.
4. The blob now exists on the user's own servers, owned by their real npub. Delete,
   quota, and any Blossom-aware client all work with any signer.
5. The bridge's copy is staging, with a short retention.

What it costs:

- The client must mirror before the bridge's copy expires. A user who does not open
  the app for a month loses the staged copy — so retention is a product decision,
  and the mirror should also run lazily on attachment open.
- Mirroring spends the user's own quota on their own servers, which is arguably
  correct.
- The sender's client cannot mirror on the recipient's behalf.

## 4. Option B — deliver a per-user upload key as NIP-44 ciphertext

Use this if the bridge's upload must be the blob's permanent home rather than
staging. It works with every signer backend and on any Blossom server.

1. **Bridge derives, statelessly, without the user's secret:**
   ```
   uploadSk = HKDF-SHA256(ikm = BRIDGE_STORAGE_SECRET,
                          info = "mailstr/blossom/v1" || userPubkey || epoch)
   ```
   Recomputable after a total DB loss. Reject `uploadSk == 0` or `>= n`.
2. Bridge signs upload auth with `uploadSk`. Blobs are owned by the pseudonym
   `uploadSk·G`.
3. Bridge publishes `nip44_encrypt(bridgeSk → userPub, nsec(uploadSk))` as a
   **replaceable kind 30078** (NIP-78) authored by the bridge with `d` = the user's
   pubkey hex. Replaceable and always fetchable beats putting it in one mail event,
   which a relay may not retain and a reinstalled client will never see. `epoch`
   in the `info` string is what lets you rotate.
4. Client calls `nip44Decrypt(bridgePubkey, content)` — **one call, works on
   Amber/bunker/extension/local alike** — caches the key, and uses it to sign
   `delete`.
5. **The client should also use this key for its own outbound uploads.** Otherwise
   sent attachments are owned by the real npub and received ones by the pseudonym,
   and the user has two buckets on every server. This is fixable purely client-side.

Note the framing: derivation is the bridge's private business, delivery is what the
user needs. Under that framing the conversation key would also *work* — but it buys
nothing over an HKDF from the bridge's own secret, and costs you the ~40% of users
whose signer is a bunker or Amber, so there is no reason to choose it.

One caution from this repo's history: `key-derivation.ts` was deleted because a
derived key was used as a **sending identity**, leaving replies with nowhere to land
(rebuild plan, Known-broken #3). A storage-only credential does not reintroduce
that — but keep the roles strictly separate and never publish `uploadSk·G` as a mail
identity.

## 5. Third-party servers will bite you for reasons unrelated to auth

These apply to **both** options and are, in practice, the larger risk:

- **MIME/extension filtering.** [blossom.band](https://blossom.band/) accepts
  "images, audio and video" on the free tier and adds only PDF/SVG/ZIP on paid. Your
  attachments are AES-GCM ciphertext — `application/octet-stream`, no recognisable
  extension, no magic bytes. Expect rejection from any server that filters by type.
  This is the single biggest threat to "store it on the user's own server", and no
  key scheme fixes it. Probe each server (BUD-06 `HEAD /upload`) before committing,
  and be ready to fall back to your own server.
- **Per-npub accounts and plans.** blossom.band gives every distinct npub its own
  subdomain and sells plans per npub. A pseudonymous upload key therefore gets a
  *separate, free-tier* account even for a user who paid — another argument for
  option A's real-npub ownership.
- **Size caps.** 20 MiB free / 100 MiB paid on blossom.band. Mail attachments
  routinely exceed that.
- **`/list` is optional and discouraged** (BUD-12). Build the attachment index from
  the user's own `imeta` tags; do not design a management UI that assumes `/list`.
- **Deletion is best-effort.** Once mirrored, copies exist on several servers. The
  UI should say "remove from this server", not imply erasure.

## 6. Fix regardless of which option wins

`verifyAuthToken` (`nostr-storage-orchestrator/proxy/blossom/src/nostr.ts:50-99`)
checks `kind`, `created_at`, `expiration`, `t` and `x`, but never a `server` tag.
BUD-11 names unscoped tokens as the significant risk: a captured `delete` token is
replayable against *any* Blossom server the same key owns blobs on. That matters far
more once tokens are being minted for third-party servers. Emit the tag in
`blossom-client.ts` and enforce it in the proxy.

Also: `index.ts:293-299` has the `GET` ownership check commented out, so blobs are
world-readable by hash. Acceptable — they are ciphertext and the hash only travels
inside a gift wrap — but it should be a decision, not a leftover.

## 7. Ruled out

- **Server-side `owner` tag mapping** (bridge signs, proxy records a different owner)
  — clean and simple, but only works on servers you control. Ruled out by the
  third-party constraint. Still worth keeping for your own server as an optimisation.
- **NIP-26 delegated event signing** — deprecated, dropped by most clients, no
  Blossom server implements it.
- **NIP-102 subkey attestation / NIP-0b on-behalf-of** — open PRs, no server support.
- **Bridge as a NIP-46 client to the user's own bunker** — correct in principle, but
  every attachment costs a round trip through a signer that may be an offline phone.
- **Conversation-key derivation** — see §2. Works only for local-key users, and once
  delivery is conceded it has no advantage over §4.

## Sources

- [BUD-01 — auth events, kind 24242](https://github.com/hzrd149/blossom/blob/master/buds/01.md)
- [BUD-02 — upload](https://github.com/hzrd149/blossom/blob/master/buds/02.md)
- [BUD-03 — user server list, kind 10063](https://github.com/hzrd149/blossom/blob/master/buds/03.md)
- [BUD-04 — mirror](https://github.com/hzrd149/blossom/blob/master/buds/04.md)
- [BUD-11 — authorization, `server`/`x` scoping](https://github.com/hzrd149/blossom/blob/master/buds/11.md)
- [BUD-12 — `/list/<pubkey>`, `DELETE /<sha256>`](https://github.com/hzrd149/blossom/blob/master/buds/12.md)
- [NIP-04 — raw unhashed `shared_x` as the AES key](https://github.com/nostr-protocol/nips/blob/master/04.md)
- [NIP-07 — full `window.nostr` surface](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [NIP-44 — conversation key derivation](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [NIP-46 — remote signer method list](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [blossom.band — free/paid limits and per-npub subdomains](https://blossom.band/)
