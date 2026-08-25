# PGP / OpenPGP support — design

**Status: proposal, 2026-08-25.** Nothing here is built yet. This is the plan to
review and revise before implementation on the `pgp-support` branch.

## Why "OpenPGP", not "PGP" or "GPG"

They are not three choices. **OpenPGP** (RFC 4880 / 9580) is the standard;
**PGP** was the original product; **GPG** (GnuPG) is the command-line program
most people actually run. A user who says "my PGP key" or "my GPG key" means the
same artifact: an OpenPGP key. We implement the **OpenPGP standard** so we
interoperate with whatever tool the correspondent uses.

In the browser that means [**OpenPGP.js**](https://openpgpjs.org) — the
maintained, audited JS implementation, WebCrypto-backed, and interoperable with
GPG-generated keys (a user can paste an armored key exported from `gpg` and it
just works). It is the only realistic option; rolling our own is out.

## What this adds

End-to-end **content** encryption *on top of* the existing transport. Today mail
already travels NIP-44-encrypted inside a gift wrap between mailstr users — but a
message bridged out to Gmail leaves as plaintext, and a message from Gmail
arrives as plaintext. PGP lets a user:

1. hold their own OpenPGP keypair (generate in-app, or import an existing one);
2. keep a keyring of correspondents' public keys;
3. **encrypt/sign** outgoing mail to correspondents whose key they hold;
4. **decrypt/verify** incoming PGP mail;
5. be **warned** before sending plaintext to a provider that can read it.

This is orthogonal to the gift-wrap layer: a PGP-encrypted body is still carried
in the RFC 2822 document inside the rumor. Two mailstr users get double
encryption; a mailstr↔Gmail pair gets the PGP layer end-to-end even though the
transport is plaintext SMTP on the Gmail side.

## Key custody — reuse the encrypted-settings pattern

**One key PER ALIAS, not one per account.** A single key bound to several
addresses advertises all of them (as user IDs on the key, and by publishing them
together to a keyserver), permanently linking those aliases in public — the exact
privacy leak aliases exist to prevent. So each owned address gets its own
independent keypair, and nothing cryptographically ties one alias to another.
The store is `pgpKeys: { [emailLowercased]: { publicKey, privateKey,
fingerprint, passphraseProtected } }`.

The **private keys** ride in the existing NIP-44-encrypted settings event
(kind 30078), exactly as `mailIndexKey` does today (see
`client/src/lib/nostr/settings.ts` and the `MailSettings` shape). Consequences,
all deliberate:

- they sync across the user's devices with no new infrastructure;
- they are never on any server in the clear (the settings content is encrypted to
  the user's own Nostr key before it leaves the device);
- losing the Nostr key loses the PGP keys too — acceptable, they are one identity.

An **optional passphrase** may additionally encrypt a private key at rest
(OpenPGP.js generate/`encryptKey({ passphrase })`) for users who want a second
factor even against a compromised Nostr key. Per-alias, so keys can have
different passphrases; the session cache is keyed by fingerprint. Default off to
keep first-run frictionless.

Correspondents' **public keys** live in a separate keyring —
`pgpKeyring: { [emailLowercased]: armoredPublicKey }` — so it also syncs.
Populated by keyserver discovery and manual paste/import.

**Resolution rule:** to encrypt to an address, an address that is one of the
user's OWN aliases resolves to that alias's own public key (so encrypt-to-self
needs no keyring entry); everyone else comes from the correspondent keyring. On
read, a message is decrypted by trying every own alias key, since the message is
encrypted only to whichever alias it was sent to.

## Key discovery — WKD first, keyserver fallback

The feature isn't complete without discovery: a manual-import-only keyring means
encryption almost never happens, because nobody pastes keys. So the composer
looks a recipient's key up automatically, from two sources in preference order.

**1. WKD (Web Key Directory) — preferred** (`lib/pgp/wkd.ts`). The key is served
by the recipient's OWN mail domain at
`https://openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<zbase32(sha1(localpart))>`
(advanced method; the direct `https://<domain>/.well-known/openpgpkey/...` layout
is tried as fallback). This is more authoritative than any keyserver — the domain
that runs the mailbox vouches for its own user — and it's what the serious PGP
providers use. **Proton, Mailbox, Posteo publish WKD; Proton even serves
permissive CORS**, so the browser fetches those keys directly. Domains that block
CORS or don't publish WKD just yield null and we fall through.

**2. keys.openpgp.org — fallback** (`lib/pgp/keyserver.ts`,
`VITE_PGP_KEYSERVER` overrides). For domains without WKD. Unlike the defunct SKS
network (anyone could upload any key for any address), keys.openpgp.org
**verifies email ownership** before serving a key by address, so a by-email hit
is a real binding. It serves `Access-Control-Allow-Origin: *`, so the browser
calls it directly too — no bridge or proxy, and only public keys ever cross the
boundary.

A browser-direct WKD lookup only works where the recipient domain sends CORS
headers. A **bridge proxy** for CORS-blocking domains (the browser calls our
endpoint, the bridge fetches the WKD URL server-to-server) is the natural next
step to widen reach; not required for the CORS-friendly providers above.

**Lookup flow** (`usePgpDiscovery`): at compose time, every recipient we don't
already hold a key for is discovered once per session (WKD then keyserver; the
keyserver rate-limits by-email hard, so we never retry a miss). A hit is saved to
the synced keyring, which flips the recipient from cleartext to encryptable with
no user action — this is what turns "have a key ⇒ encrypt" into the default
experience. A miss or any error is silent and just leaves that recipient as
cleartext; discovery never blocks or errors the send.

**Publish** (`POST /vks/v1/upload` then `POST /vks/v1/request-verify`): when a
user **generates** a key, we upload the PUBLIC half so others can discover it,
then request email verification for the address. Upload makes the key
retrievable by fingerprint immediately; by-email discovery only works after the
address owner clicks the verification link the keyserver emails them (for a
mailstr address, that email arrives through the bridge). Best-effort — a publish
failure never undoes the already-saved key, it just means the user isn't
discoverable yet. Only the public key is ever uploaded; the private key never
leaves the encrypted settings blob.

**Still manual as a fallback:** paste/import remains, for correspondents who
haven't published or aren't on this keyserver. WKD (domain-served keys) is a
natural second discovery source for a later pass.

## Compose

- An **Encrypt** toggle in the composer, available **only when every recipient
  (To + CC) has a key in the keyring**. Missing one → toggle unavailable, with
  the reason inline ("No PGP key for bob@gmail.com — import one to encrypt").
- **Encrypt-by-default, with a cleartext-provider exception.** When encryption
  is possible the toggle defaults **on** — protecting mail is the point, and
  requiring a click each time trains people to skip it. The exception: if any
  recipient is on a known cleartext-only provider (gmail/outlook/yahoo/…), it
  defaults **off**, because a webmail user typically can't read PGP and silently
  encrypting hands them an unreadable blob. Either way it stays a live per-
  message toggle, and a manual flip sticks for that draft (a reactive default
  must never fight a deliberate choice).
- When on: encrypt the body to **all recipients plus the From alias itself** (so
  the Sent copy in our own self-wrap stays readable), and **sign** with the
  **From alias's** key. Per-alias means the toggle needs a key for the specific
  From address; switching From to an alias without a key disables it, with the
  reason shown.
- **Inline PGP** (armored `-----BEGIN PGP MESSAGE-----` body) for v1. **PGP/MIME**
  (which covers attachments and HTML cleanly) is the phase-2 upgrade; call it out
  as a known limitation rather than half-doing it.
- **Subject stays plaintext.** Threading and the mailbox list key off it
  (`Email.subject`, RFC 2822 headers). This matches every real PGP mail client;
  note it honestly in the UI so nobody assumes the subject is protected.

## Read

- On decode (`client/src/lib/mail/receive.ts`), detect a PGP body
  (`-----BEGIN PGP MESSAGE-----`). If we hold the private key, decrypt; render
  the plaintext with a clear "decrypted" indicator.
- **Signature state, shown honestly** — the same philosophy as `SenderProof`
  (see `client/src/types/mail.ts`): say exactly which check passed. Distinct
  states: `signed-valid` (and by which key), `signed-unknown-key` (valid math,
  key not in our ring), `signed-invalid` (verification FAILED — a loud warning),
  `unsigned`. Never a vague "verified" badge.
- Can't decrypt (not our key / no key) → show the armored blob with an
  explanation, don't silently blank the message.

## Warnings

- **Plaintext-provider banner**: when composing unencrypted to a recipient on a
  known cleartext provider (gmail.com, outlook/hotmail, yahoo, proton's
  non-PGP addresses, …), show a dismissible "this message can be read by the
  provider" notice. A small static domain list to start; not a security control,
  just an honest nudge.
- **Missing-key state** on the Encrypt toggle as above.
- **Bad signature** on read is the one hard, non-dismissible warning.

## Stated limitations (write these into the UI, not just the docs)

- subject + headers are not encrypted;
- v1 is inline-PGP, so attachments on an encrypted message are not yet
  encrypted by the PGP layer (they still ride the existing Blossom encryption
  path — flag the distinction);
- discovery relies on the recipient having published to keys.openpgp.org and
  verified their address; correspondents who haven't still need a manual import;
- encrypted mail to a non-PGP client arrives as an armored blob the recipient
  can't read — the Encrypt toggle being recipient-gated is what prevents this by
  accident, but a determined user can still do it.

## Rough build order

1. OpenPGP.js dependency + a `lib/pgp/` module wrapping generate / import /
   export / encrypt / decrypt / sign / verify. Unit-tested in isolation.
2. Settings schema: `pgpPrivateKey` (+ optional passphrase flag), `pgpKeyring`.
   Reuse `settings.ts` save/load; no new relay code.
3. Settings UI: an Encryption section — generate / import / export / show
   fingerprint; keyring management (add/remove correspondent keys).
4. Read path: detect + decrypt + signature state in `receive.ts` and
   `EmailView`.
5. Compose path: recipient-gated Encrypt toggle (default-on when possible),
   encrypt-to-all-plus-self, sign, plaintext-provider warning.
6. Keyserver: lookup at compose time (auto-enrich the keyring) and publish on
   key generation (`lib/pgp/keyserver.ts`).
7. Docs + honest in-UI limitation copy.

PGP/MIME, attachment encryption, and WKD (domain-served) discovery are
explicitly **phase 2**, tracked separately.
