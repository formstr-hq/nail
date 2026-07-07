# Mail by Form* — Agent & Developer Reference

## Project Overview

**Mail by Form*** is a Nostr-native email client built on the [Nostr Mail Protocol](https://nostr-mail.dev).
It replaces SMTP between users with Nostr event transport while maintaining full interoperability
with legacy email via a bridge. The bridge used is **`mail.formstr.app`**.

- Protocol spec: https://nostr-mail.dev
- Reference repo: https://github.com/nogringo/nostr-mail
- Stack: React + TypeScript + Vite + Tailwind + shadcn/ui

---

## Core Protocol

### Event Kind
- **Kind 1301** — Email event (the "rumor" inside a gift-wrapped NIP-59 envelope)
- **Kind 1059** — NIP-59 gift-wrap wrapper (what is actually published to relays)
- **Kind 10050** — DM relay list (NIP-17); used to find where to publish for a recipient
- **Kind 1985** — Label events (NIP-32); used for folders, read state, flags
- **Kind 30078** — App-specific settings (NIP-78); parameterized replaceable event

### Email Content Format
Content of Kind 1301 is a standard **RFC 2822** formatted email string. Example:

```
From: Alice <alice@example.com>
To: Bob <bob@example.com>
Subject: Hello
Date: Sat, 19 Apr 2026 10:00:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8

Hello Bob, this is a Nostr mail.
```

All standard RFC 2822 headers apply: `CC`, `BCC`, `In-Reply-To`, `References`, `Content-Type`, etc.
Threading uses `In-Reply-To` and `References` exactly as in legacy email.

### NIP-59 Gift Wrapping (Privacy)
All Kind 1301 events are **gift-wrapped** before publishing. Relays only ever see:
- The recipient's pubkey
- An encrypted blob (the Kind 1301 rumor + metadata)

Never publish unwrapped Kind 1301 events to relays.

### Relay Discovery (NIP-17)
To publish to a recipient, fetch their **Kind 10050** event (DM relay list).
Publish the gift-wrapped event to each relay in that list.

---

## Recipient Resolution Flow

Given a recipient string, resolve it as follows:

1. **npub / hex pubkey** → use directly
2. **NIP-05 identifier** (`user@domain.com`) → GET `https://domain.com/.well-known/nostr.json?name=user` → extract pubkey
3. **Legacy email** (`user@domain.com` where domain is NOT a Nostr domain) → route to bridge

### Bridge Routing for Legacy Email
- Bridge npub is discovered via NIP-05 lookup: `_smtp@mail.formstr.app`
  - GET `https://mail.formstr.app/.well-known/nostr.json?name=_smtp`
- Send a Kind 1301 event **to the bridge's pubkey** (gift-wrapped)
- Put the legacy recipient address in the `To:` header of the RFC 2822 content
- The bridge extracts `To:` and forwards via SMTP

### Inbound Legacy Email
- A user's bridge email address is: `<npub>@mail.formstr.app` or `<nip05-local>@mail.formstr.app`
- The bridge receives SMTP email, resolves the Nostr pubkey from the address, gift-wraps and publishes Kind 1059 to the user's relay list

---

## Multiple Recipients (CC / BCC)

- Use standard RFC 2822 `To:`, `CC:`, `BCC:` headers in the email content
- For each **Nostr recipient** (resolved to a pubkey): send a separate gift-wrapped Kind 1301 event
- For **legacy recipients**: the bridge handles them from the email headers
- BCC: strip `BCC:` header before sending to non-BCC recipients (standard email behaviour)

---

## Attachments

### Small attachments (< 60 KB)
Embed directly as MIME multipart content in the RFC 2822 body inside the Kind 1301 event content field.

### Large attachments (≥ 60 KB) — Blossom
NIP-44 encryption has a 65,535-byte plaintext limit, so large MIME bodies are offloaded:

1. Generate AES-GCM encryption key + nonce
2. Encrypt the full MIME payload with AES-GCM
3. Upload the encrypted blob to a Blossom server
4. Leave Kind 1301 `content` field **empty**
5. Add tags to the Kind 1301 rumor:
   - `["x", "<blossom-url>"]` — URL of the encrypted blob
   - `["key", "<hex-aes-key>"]`
   - `["nonce", "<hex-nonce>"]`

**Detection on receive**: If `content` is empty but an `["x", ...]` tag is present → fetch from Blossom, decrypt with key/nonce, parse MIME.

---

## Labels / Folders (Kind 1985, NIP-32)

Labels are **separate events** pointing to the gift-wrap event ID (Kind 1059 ID, not Kind 1301).
Namespace: `"mail"`

| Tag | Meaning |
|-----|---------|
| `["l", "trash", "mail"]` | Moved to trash |
| `["l", "archive", "mail"]` | Archived |
| `["l", "spam", "mail"]` | Marked spam |
| `["l", "state:read", "mail"]` | Mark as read (default = unread) |
| `["l", "flag:starred", "mail"]` | Starred |
| `["l", "flag:important", "mail"]` | Important |
| `["l", "tag:<name>", "mail"]` | Custom tag/folder |

To **remove** a label: publish a Kind 5 deletion event targeting the Kind 1985 label event ID.
To **sync**: subscribe to Kind 1985 events from the user's write relays filtered by `#e` pointing to known email event IDs.

---

## Settings (Kind 30078, NIP-78)

Parameterized replaceable event with `d` tag identifying the setting group.

### Public settings (unencrypted)
- `dm_copy` — ask bridge to send a DM copy of incoming emails

### Private settings (NIP-44 encrypted to self)
- Default sender address (e.g. `user@mail.formstr.app`)
- Email signature for outgoing messages
- List of preferred bridge domains

---

## Authentication

Two supported login methods:
1. **NIP-07 browser extension** (nos2x, Alby) — preferred for web; private key never exposed to app
2. **Import nsec / generate new keypair** — store securely (browser: encrypted localStorage)

One account at a time. Public key = user identity. Private key = sole credential, never leave device.

---

## Bridge: mail.formstr.app

| | |
|-|-|
| Bridge domain | `mail.formstr.app` |
| NIP-05 discovery | GET `https://mail.formstr.app/.well-known/nostr.json?name=_smtp` |
| User inbound address | `<npub>@mail.formstr.app` |
| Outbound routing | Send Kind 1301 to bridge pubkey; legacy address in `To:` header |

The bridge is a **trusted third party** for legacy email paths — it necessarily sees plaintext when bridging to SMTP. This is acceptable and should be communicated to users in the UI when composing to legacy addresses.

---

## NIPs Reference

| NIP | Usage |
|-----|-------|
| NIP-01 | Basic Nostr protocol |
| NIP-05 | User & bridge discovery via DNS/HTTP |
| NIP-17 | DM relay lists (Kind 10050) for recipient relay routing |
| NIP-32 | Labels (Kind 1985) for folders, read state, flags |
| NIP-44 | Encryption primitive used inside NIP-59 |
| NIP-59 | Gift-wrap (Kind 1059) — all emails are published as this |
| NIP-65 | Relay list metadata |
| NIP-78 | App-specific data (Kind 30078) for settings |

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Framework | React 18 + TypeScript |
| Build | Vite |
| Styling | Tailwind CSS |
| Components | shadcn/ui |
| Nostr | nostr-tools (event building, NIP-44, NIP-59) |
| Email parsing | `mailparser` or `postal-mime` (RFC 2822) |
| Key storage | NIP-07 extension preferred; fallback to encrypted localStorage |

---

## Key Implementation Notes

- **Never** publish raw Kind 1301 to relays — always gift-wrap with NIP-59 first
- **Always** fetch Kind 10050 relay list before publishing to a recipient
- Kind 1059 outer gift-wrap **must** include `["k", "1301"]` tag — follows NIP-17 precedent, allows relay filtering via `#k` without revealing content
- Kind 1059 `created_at` should be randomised (±2 days) for metadata privacy per NIP-59
- On receive: subscribe to Kind 1059 on own relay list → unwrap → parse RFC 2822 → store
- Dedup received events by Kind 1059 event ID before storing
- Malformed/undecryptable events should be silently skipped
- Threading: group emails by `Message-ID` / `In-Reply-To` / `References` headers
- Read state is local-first, synced via Kind 1985 label events
