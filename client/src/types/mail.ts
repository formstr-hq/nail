export interface MailAddress {
  name?: string
  address: string
}

export interface Attachment {
  filename: string
  contentType: string
  size: number
  // For inline MIME
  data?: Uint8Array
  // For Blossom-hosted large attachments
  blossomUrl?: string
  blossomKey?: string
  blossomNonce?: string
}

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
