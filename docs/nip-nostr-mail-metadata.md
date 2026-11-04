NIP-XX
======

Nostr Mail Metadata
-------------------

`draft` `optional`

Kind `34578` is the Nostr Mail metadata event: one encrypted, addressable event per message carrying that message's state — read, its folder, its labels, and deletion — synced across the user's clients. Folders and labels are custom and defined in settings.

## Event

```jsonc
{
  "kind": 34578,
  "pubkey": "<author>",
  "created_at": 1757800000,
  "tags": [["d", "<coordinate>"]],
  "content": "<NIP-44 ciphertext>",
  "id": "...",
  "sig": "..."
}
```

`content` is a JSON object encrypted with [NIP-44](44.md) to the author's own key. After decryption:

```json
{
  "v": 1,
  "ref": "<message id>",
  "read": true,
  "folder": "<folder id>",
  "labels": ["<label id>"],
  "deleted": false
}
```

`ref` is the message's [Nostr Mail](nostr-mail-core.md) id — the rumor id for a gift-wrapped message, the event id for a public one. The event is rewritten whole: every publish carries the message's complete state.

`read` and `deleted` are the message's own flags. `folder` is the single folder the message is in; `labels` is any number of labels. Both name entries defined in settings, below, and either absent means none.

The event carries no `t` tag, so it is indistinguishable from any other kind `34578` on the relay.

## Coordinate

`<coordinate>` is `HMAC-SHA256(mailIndexKey, ref)` in lowercase hex. `mailIndexKey` is a 32-byte hex secret held in the mail settings event (kind `30078`, `d = mail-settings`), whose `content` is [NIP-44](44.md) ciphertext of a JSON object.

The natural coordinate — the message's own id — would let anyone serving the relay learn which messages a user read, filed, labelled, or deleted. Keying it under a secret only the user holds keeps the coordinate unlinkable, while staying deterministic: rewrites of the same message's state land on the same event.

Because the coordinate is opaque, a client cannot filter these events by `d`. It fetches `authors = [pubkey]` and identifies its own by decrypting.

## Reading

An event that does not decrypt to a `v: 1` object with a string `ref` is not ours and is ignored — another app's metadata, or a blob for a key this client cannot open.

A message with no metadata event is unread, unfiled, unlabelled, not deleted. `deleted` is the cross-device tombstone that keeps a message hidden after a [NIP-09](09.md) deletion request is ignored.

State is published to the user's [NIP-17](17.md) DM relays (kind `10050`), the same relays as mail, and travels with the mailbox.

## Folders

Folders are custom: the protocol defines none. A client keeps the folders it offers in a `folders` array in the mail settings event. Which folders exist, and which a client seeds by default, is the client's choice. Each entry:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | client-chosen, unique among folders, stable for the folder's life |
| `name` | string | yes | 1–64 characters after trimming, unique case-insensitively |
| `color` | string | no | `#RRGGBB`; derived from `id` when absent |
| `position` | integer | no | ascending sort key; an entry without one sorts last, ties broken by `name` |
| `match` | object | no | condition, below |

An `id` is never reused. When a client rewrites an entry it MUST keep the fields it does not change.

A message's folder is the `folder` field of its metadata event; a message with no `folder` is unfiled. A `match` files a message without any state being written. It matches when all of its present fields do:

| Field | Matches when |
|---|---|
| `from` | the sender address equals an entry, or ends with `@` or `.` followed by one |
| `subject` | the subject contains an entry |
| `has_attachment` | the message carries an attachment, or none when `false` |
| `spam` | the receiving server marked the message as spam |

Entries of one field are OR; the fields are AND. Text is compared case-insensitively. A `match` with no fields matches nothing.

`spam` is a property of the message, not user state: it comes from the receiving
server's authenticated marker. A client SHOULD prefer a marker added by the
bridge that wrapped the message (the bridge is the last hop and strips
sender-supplied spam headers), falling back to `X-Spam-Flag` for mail from other
bridges or older messages.

A message is in the folder named by its `folder` field; failing that, the first folder (by `position`) whose `match` it matches; failing that, unfiled.

An explicit `folder` — **including `"inbox"`** — always wins over a match.
Storing `"inbox"` is how a client rescues a matched message (the default Spam
folder's `spam` rule) without inventing a second flag; a client that treats an
absent folder and `"inbox"` as identical cannot implement "Not spam".

## Labels

A label is a folder-shaped entry — `id`, `name`, `color`, `position`, `match` — held in a `labels` array in the same settings event. A message carries any number of them, by id, in the `labels` field of its metadata event; a label's `match` adds it without any state being written. Unlike folders, labels are not exclusive: a message may carry any number, and they never move it between folders.

[Nostr Mail]: nostr-mail-core.md
