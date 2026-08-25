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

The user's **private key** rides in the existing NIP-44-encrypted settings event
(kind 30078), exactly as `mailIndexKey` does today (see
`client/src/lib/nostr/settings.ts` and the `MailSettings` shape). Consequences,
all deliberate:

- it syncs across the user's devices with no new infrastructure;
- it is never on any server in the clear (the settings content is encrypted to
  the user's own Nostr key before it leaves the device);
- losing the Nostr key loses the PGP key too — acceptable, they are one identity.

An **optional passphrase** may additionally encrypt the private key at rest
(OpenPGP.js `encryptKey({ passphrase })`) for users who want a second factor even
against a compromised Nostr key. Default off to keep first-run frictionless.

Correspondents' **public keys** live in a local keyring — a new field in
settings, `pgpKeyring: { [emailLowercased]: armoredPublicKey }` — so it also
syncs. Imported by paste or `.asc` upload.

## No key discovery in v1

Deliberately **no keyserver / WKD lookups** to start. Automated discovery is
where OpenPGP historically leaks (which correspondents you're about to write to)
and where trust gets murky (a keyserver can hand you any key). v1 is
**manual exchange only**: you paste or import a key you obtained out of band.
WKD / opt-in keyserver discovery is a later phase, gated behind an explicit
setting, once the core is solid.

## Compose

- An **Encrypt** toggle in the composer, enabled **only when every recipient
  (To + CC) has a key in the keyring**. Missing one → toggle disabled, with the
  reason inline ("No PGP key for bob@gmail.com — import one to encrypt").
- When on: encrypt the body to **all recipients plus self** (so the Sent copy in
  our own self-wrap stays readable), and **sign by default** with the user's key.
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
- key exchange is manual;
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
5. Compose path: recipient-gated Encrypt toggle, encrypt-to-all-plus-self,
   sign, plaintext-provider warning.
6. Docs + honest in-UI limitation copy.

PGP/MIME, attachment encryption, and WKD/keyserver discovery are explicitly
**phase 2**, tracked separately.
