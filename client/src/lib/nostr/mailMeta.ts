import type { Event } from 'nostr-tools'
import type { ActiveSigner } from '@formstr/signer'
import type { MailFlags } from '@/types/mail'
import { fetchDmRelays } from './relays'
import { getLocalRelay } from './localRelay'
import { withSignerTimeout } from './signer'
import { KIND_MAIL_META } from './constants'

/**
 * Per-mail state (read / archived / trashed) as NIP-Metadata events.
 *
 * Each mail's state is one addressable kind-34578 event whose content is a JSON
 * blob NIP-44 encrypted to the author's own key. The archive/trash "labels" the
 * server can't back (they only ever lived in the UI) are expressed here instead,
 * client-side, and synced across devices via the relays.
 *
 * The privacy problem this solves: the natural coordinate for "state about mail
 * X" is the gift-wrap id, but the wrap is p-tagged publicly to the recipient, so
 * a plaintext coordinate would let anyone serving the relay learn exactly which
 * of your mail you archived, trashed, or read. Instead the `d` tag is a keyed
 * HMAC of the gift-wrap id under a secret only you hold (the mail index key,
 * kept in your encrypted settings). The mapping is deterministic — so the same
 * mail always resolves to the same coordinate, giving free upsert semantics —
 * but unlinkable to the wrap without the key. The real gift-wrap id lives only
 * inside the encrypted content. We also omit the optional `["t", …]` sub-type
 * tag, so these are indistinguishable from any other kind-34578 metadata.
 */

const CONTENT_VERSION = 1

interface MailMetaContent {
  v: number
  ref: string // gift-wrap (kind 1059) event id this state is about
  read?: boolean
  archived?: boolean
  trashed?: boolean
  deleted?: boolean // permanently deleted — see MailFlags.deleted
}

// ── small hex helpers (avoid a direct @noble dep, which is only transitive) ──

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** A fresh 32-byte secret, hex-encoded, for keying mail-metadata coordinates. */
export function randomMailIndexKey(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * The opaque `d`-tag coordinate for a mail's state event: HMAC-SHA256 of the
 * gift-wrap id under the account's mail index key. Deterministic (so re-acting
 * on the same mail overwrites its event) yet unlinkable to the wrap without the
 * key. Uses Web Crypto, present in both the web build and the Capacitor WebView.
 */
export async function mailMetaCoordinate(indexKey: string, giftwrapId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(indexKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(giftwrapId))
  return bytesToHex(new Uint8Array(sig))
}

/**
 * Publish (or overwrite) the state event for one mail. The full flag set is
 * written every time — the caller passes the merged current flags, not just the
 * delta — so a single addressable event always holds the mail's complete state.
 */
export async function publishMailMeta(
  giftwrapId: string,
  flags: MailFlags,
  pubkey: string,
  active: ActiveSigner,
  indexKey: string,
): Promise<void> {
  const d = await mailMetaCoordinate(indexKey, giftwrapId)
  const content: MailMetaContent = {
    v: CONTENT_VERSION,
    ref: giftwrapId,
    read: flags.read,
    archived: flags.archived,
    trashed: flags.trashed,
    deleted: flags.deleted,
  }

  const encrypted = await withSignerTimeout('nip44Encrypt', () =>
    active.nip44Encrypt(pubkey, JSON.stringify(content)),
  )

  const event = await withSignerTimeout('signEvent', () =>
    active.signEvent({
      kind: KIND_MAIL_META,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', d]],
      content: encrypted,
    }),
  )

  // These live on the same DM relays as settings and gift wraps, so mail state
  // travels with the mailbox. The durable outbox re-delivers to any relay that
  // doesn't accept immediately.
  const relays = await fetchDmRelays(pubkey)
  const outcomes = await getLocalRelay().publish(event, { relays })
  if (!outcomes.some((o) => o.status === 'accepted')) {
    const reason = outcomes.find((o) => o.message)?.message ?? 'no relay accepted the event'
    throw new Error(`Could not save mail state: ${reason}`)
  }
}

/** One decoded state entry: which mail, its flags, and the event's timestamp. */
export interface MailMetaEntry {
  ref: string
  flags: MailFlags
  eventId: string
}

/**
 * Decode one kind-34578 event into a mail-state entry, or `null` if it isn't
 * one of ours. We can't filter these on the relay (no `t` tag, opaque `d` tag),
 * so identity is established by successfully decrypting the content and finding
 * our versioned shape — anything else (another app's metadata, an undecryptable
 * blob) is skipped.
 */
export async function decodeMailMeta(
  event: Event,
  pubkey: string,
  active: ActiveSigner,
): Promise<MailMetaEntry | null> {
  let parsed: MailMetaContent
  try {
    const plaintext = await withSignerTimeout('nip44Decrypt', () =>
      active.nip44Decrypt(pubkey, event.content),
    )
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (parsed?.v !== CONTENT_VERSION || typeof parsed.ref !== 'string') return null
  return {
    ref: parsed.ref,
    eventId: event.id,
    flags: {
      read: !!parsed.read,
      archived: !!parsed.archived,
      trashed: !!parsed.trashed,
      deleted: !!parsed.deleted,
      updatedAt: event.created_at,
    },
  }
}
