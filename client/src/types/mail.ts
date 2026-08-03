export interface MailAddress {
  name?: string
  address: string
}

export interface Attachment {
  filename: string
  contentType: string
  /** Undefined for Blossom-hosted files, whose size is unknown until fetched. */
  size?: number
  // Inline MIME part: the bytes travelled inside the message itself.
  data?: Uint8Array
  // Blossom-hosted: fetched on demand. Key and nonce are absent when the
  // sender hosted the file unencrypted, which `imeta` permits.
  blossomUrl?: string
  blossomKey?: string
  blossomNonce?: string
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
 *  - `bridge-seal` — the configured bridge sealed it. The bridge refuses to
 *    relay a `From` the sending key does not own, so the header is backed.
 *    Also means the message came from the SMTP side rather than peer-to-peer.
 *  - `own-seal`    — we sealed it. Our own outgoing copy.
 *  - `nip05`       — the address's NIP-05 record resolves to the sealing key.
 *  - `none`        — nothing backs the header, so the sealing key is shown
 *                    instead and the header is not displayed as the sender.
 */
export type SenderProof = 'bridge-seal' | 'own-seal' | 'nip05' | 'none'

export interface Email {
  id: string               // Kind 1059 gift-wrap event ID
  messageId?: string       // RFC 2822 Message-ID header
  inReplyTo?: string       // RFC 2822 In-Reply-To header
  references?: string[]    // RFC 2822 References header
  from: MailAddress
  to: MailAddress[]
  cc?: MailAddress[]
  subject: string
  body: string
  bodyHtml?: string
  attachments: Attachment[]
  timestamp: number        // unix seconds
  senderPubkey: string     // hex pubkey of sender
  senderProof: SenderProof // what backs `from` — see SenderProof
  read: boolean
  labelEventIds: string[]  // Kind 1985 event IDs managing this email's labels
  labels: string[]         // e.g. ['trash', 'flag:starred', 'state:read']
}

export type EmailFolder = 'inbox' | 'sent' | 'trash' | 'archive' | 'spam'

export interface Thread {
  id: string               // root Message-ID
  emails: Email[]
  subject: string
  lastTimestamp: number
  participants: MailAddress[]
  hasUnread: boolean
}
