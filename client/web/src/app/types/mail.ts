export interface MailAddress {
  name?: string
  address: string
}

export interface Attachment {
  filename: string
  contentType: string
  /** Known for inline files and NIP-FS-hosted ones. */
  size?: number
  // Inline MIME part: the bytes travelled inside the message itself.
  data?: Uint8Array
  // Blossom-hosted: fetched on demand. Key is absent when the sender hosted
  // the file unencrypted, which `imeta` permits.
  blossomUrl?: string
  blossomKey?: string
  // Legacy one-shot-AES-GCM format only (what the bridge used to write).
  blossomNonce?: string
  // NIP-FS / drive-sdk format only — required alongside key + size to decrypt
  // via `@formstr/drive-sdk`'s `decryptFileBytes`.
  blossomBlobHash?: string
  blossomFileHash?: string
  // A drive share link carried in the body/attachments.txt for recipients
  // without a Mailstr client. Our own reader resolves it on download.
  shareUrl?: string
}

/**
 * What backs the sender shown on a message.
 *
 * An RFC 2822 `From:` header is just text the sender chose, so displaying it
 * is only honest when something actually vouches for it. Each value names one
 * check that was performed — there is deliberately no generic "verified",
 * because "the bridge vouched for this" and "this address's NIP-05 record
 * resolves to the sealing key" are different claims and the UI says which.
 *
 * This is DERIVED AT RENDER TIME, never stored on the decoded email: bridge
 * resolution is asynchronous, so a proof computed during decode would freeze
 * whatever happened to be known then — and a message decoded before the
 * bridge key landed would show as unverified forever (see lib/mail/
 * senderProof.ts). The email carries the raw header; the proof is a function
 * of it, the sealing key, and the current resolution state.
 *
 *  - `bridge-seal`         — a configured bridge sealed it. The bridge refuses
 *                            to relay a `From` the sending key does not own,
 *                            so the header is backed. Also means the message
 *                            came from the SMTP side rather than peer-to-peer.
 *  - `own-seal`            — we sealed it. Our own outgoing copy.
 *  - `nip05`               — the address's NIP-05 record resolves to the
 *                            sealing key.
 *  - `checking`            — a check that could still back the header (a
 *                            bridge resolution or an in-flight NIP-05 probe)
 *                            has not finished, so no verdict is available yet.
 *  - `bridge-unavailable`  — every configured bridge failed to resolve, so the
 *                            bridge check could not be performed at all. This
 *                            is distinct from `none`: the header is not shown,
 *                            but the reason is our own resolver's failure, not
 *                            evidence about the sender.
 *  - `none`                — nothing backs the header, so the sealing key is
 *                            shown instead and the header is not displayed as
 *                            the sender.
 */
export type SenderProof =
  | 'bridge-seal'
  | 'own-seal'
  | 'nip05'
  | 'checking'
  | 'bridge-unavailable'
  | 'none'

/**
 * The decoded inner rumor, kept for the reader's debug disclosure. Lets you see
 * exactly what arrived on the wire — kind, sender key, tags, raw content —
 * which is the ground truth when a message renders in a way that looks wrong
 * (e.g. an empty body: is it really empty, or did parsing drop it?).
 */
export interface RumorDebug {
  sealPubkey: string
  rumor: {
    id: string
    kind: number
    pubkey: string
    created_at: number
    tags: string[][]
    content: string
  }
}

export interface Email {
  id: string               // Kind 1059 gift-wrap event ID
  /**
   * Wrap ids for a chunked message, in order. `id` is chunk 0; each part has
   * its own wrap and its own ephemeral key, so permanent delete must publish
   * one NIP-09 per id. Absent for ordinary single-wrap mail.
   */
  wrapIds?: string[]
  messageId?: string       // RFC 2822 Message-ID header
  inReplyTo?: string       // RFC 2822 In-Reply-To header
  references?: string[]    // RFC 2822 References header
  /**
   * The RFC 2822 `From:` header exactly as it arrived — claimed, not trusted.
   * Whether it may be shown is decided at render time (lib/mail/senderProof.ts)
   * from the sealing key plus the current bridge/NIP-05 resolution state.
   */
  fromHeader: MailAddress
  to: MailAddress[]
  cc?: MailAddress[]
  subject: string
  body: string
  bodyHtml?: string
  attachments: Attachment[]
  timestamp: number        // unix seconds
  senderPubkey: string     // hex pubkey of sender
  read: boolean
  labelEventIds: string[]  // Kind 1985 event IDs managing this email's labels
  labels: string[]         // e.g. ['trash', 'flag:starred', 'state:read']
  /**
   * Present while a chunked message is still arriving. The reader shows the
   * contiguous prefix and this progress, then replaces it when the last part
   * lands. `missing` lets the UI name/retry the absent chunks. `headerless`
   * marks a placeholder created before chunk 0 arrived: the body is the parts
   * we have, but the headers are still unknown.
   */
  partial?: {
    have: number
    total: number
    missing: number[]
    headerless?: boolean
  }
  /**
   * Internal: the synthetic headerless-placeholder id this message replaces
   * when chunk 0 arrives. Never rendered.
   */
  pendingId?: string
  /**
   * The receiving server marked this message as spam (`X-Spam-Flag`).
   *
   * Derived at decode time from the message itself, never stored: it is a
   * property of the mail, not user state. Folder `match` rules consume it, and
   * an explicit `folder` (including `inbox`) overrides it, so "Not spam" is a
   * normal filing action rather than a second flag.
   */
  spam?: boolean
  debug?: RumorDebug       // raw decoded rumor, for the reader's debug view
}

export type EmailFolder = 'inbox' | 'sent' | 'trash' | 'archive' | 'spam'

/**
 * A folder or label `match` condition. All present fields must match; entries
 * within one field are OR-ed. Text comparisons are case-insensitive.
 */
export interface FolderMatch {
  /** Sender address equals an entry, or ends with `@` or `.` + entry. */
  from?: string[]
  /** Subject contains an entry. */
  subject?: string[]
  /** The message has (or has no) attachments. */
  has_attachment?: boolean
  /** The receiving server marked the message as spam. */
  spam?: boolean
}

/** A folder or label definition, synced in the mail settings event. */
export interface FolderEntry {
  /** Client-chosen, unique among folders, stable for the folder's life. */
  id: string
  /** 1–64 characters, unique case-insensitively after trimming. */
  name: string
  color?: string
  /** Ascending sort key; absent sorts last, ties broken by name. */
  position?: number
  match?: FolderMatch
}

/** Labels are folder-shaped but non-exclusive. */
export type LabelEntry = FolderEntry

/**
 * Per-mail state synced across devices as a kind-34578 metadata event, keyed by
 * gift-wrap id. `updatedAt` (unix seconds) is the event's `created_at` — used to
 * resolve which of two versions of the same mail's state is newer, so a stale
 * relay replay never clobbers a fresh local or cross-device change.
 *
 * Spam is deliberately NOT a flag here: it is derived from the message and
 * expressed through a folder `match`. What *is* stored is the explicit folder,
 * which overrides a match — that is how a user rescues a false positive (and
 * why `folder: 'inbox'` is a meaningful stored value, not just the default).
 */
export interface MailFlags {
  read?: boolean
  /**
   * The folder the mail is filed in, by id. Absent means the folder resolved
   * from `match` rules, or the natural mailbox (Sent when the user authored
   * it, Inbox otherwise). An explicit `'inbox'` is stored only to override a
   * match (e.g. "Not spam"); otherwise Inbox is the implicit default.
   */
  folder?: string
  /**
   * Labels the message carries, by id. Unlike `folder`, a message may carry
   * any number. Definitions live in settings alongside the folders.
   */
  labels?: string[]
  /**
   * Permanently deleted. The kind-5 deletion is a separate, best-effort purge
   * of the wrap from relays (see lib/nostr/delete.ts); THIS flag is the
   * cross-device record that the mail is gone, so it stays hidden even on
   * relays that ignored the deletion and keep serving the wrap.
   */
  deleted?: boolean
  updatedAt: number
}

export interface Thread {
  id: string               // root Message-ID
  emails: Email[]
  subject: string
  lastTimestamp: number
  participants: MailAddress[]
  hasUnread: boolean
}
