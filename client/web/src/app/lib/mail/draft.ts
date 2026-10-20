import type { Email, MailAddress } from '@/app/types/mail'

/** A compose window's starting contents. Used verbatim — no further munging. */
export interface Draft {
  to: string
  subject: string
  body: string
  /**
   * The account address that should be selected as From when this draft opens.
   *
   * A reply pins the address the original message was delivered to. That is
   * the mailbox the correspondent actually wrote to, so it — not the sidebar's
   * currently active inbox — must be the sender. Absent for a new message or a
   * forward, where the composer derives the From normally.
   */
  from?: string
  inReplyTo?: string
  references?: string[]
}

/**
 * The sender a reply/forward should address and quote.
 *
 * Callers pass the EFFECTIVE sender (header when backed, sealing key when
 * not), never `email.fromHeader` directly: a spoofed header must not become
 * the reply's recipient, and the quoted attribution must name the identity the
 * reader was actually shown.
 */
function senderOf(email: Email, sender?: MailAddress): MailAddress {
  return sender ?? email.fromHeader
}

/**
 * Add a prefix unless the subject already carries it.
 *
 * Replying to a reply must not produce "Re: Re: Re:". Matching is loose on
 * purpose: mail clients emit `Re:`, `RE:` and `Re :`, and some localised ones
 * send `Fwd:` where others send `FW:`.
 */
function prefixOnce(subject: string, prefix: 'Re' | 'Fwd'): string {
  const trimmed = subject.trim()
  const already =
    prefix === 'Re'
      ? /^re\s*:/i.test(trimmed)
      : /^(fwd?|fw)\s*:/i.test(trimmed)
  return already ? trimmed : `${prefix}: ${trimmed}`
}

/**
 * RFC 5322 §3.6.4: References is the parent's References plus its Message-ID,
 * which is what lets a receiving client rebuild the thread. Dropping it is why
 * replies show up as new conversations.
 */
function threadRefs(email: Email): string[] | undefined {
  const chain = [...(email.references ?? []), ...(email.messageId ? [email.messageId] : [])]
  return chain.length ? chain : undefined
}

/**
 * The account address this message was delivered to — the From a reply should
 * use. `To`/`Cc` are checked first because they are the recipient headers a
 * received message carries; the `From` header is the fallback for a message
 * from the user's own Sent folder, whose To list names correspondents instead.
 *
 * Only addresses the account actually owns are considered, and the spelling
 * from the message is preserved so the composer can match a self option.
 */
function deliveredTo(email: Email, self: string[]): string | undefined {
  if (self.length === 0) return undefined
  const mine = new Set(self.map((a) => a.trim().toLowerCase()).filter(Boolean))
  for (const { address } of [...email.to, ...(email.cc ?? []), email.fromHeader]) {
    const trimmed = address.trim()
    if (trimmed && mine.has(trimmed.toLowerCase())) return trimmed
  }
  return undefined
}

/** `> ` quoting, with an attribution line above it. */
function quote(email: Email, sender: MailAddress): string {
  const when = new Date(email.timestamp * 1000).toLocaleString()
  const who = sender.name ? `${sender.name} <${sender.address}>` : sender.address
  const quoted = email.body
    .trimEnd()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
  return `\n\nOn ${when}, ${who} wrote:\n${quoted}\n`
}

export function replyDraft(
  email: Email,
  sender?: MailAddress,
  self: string[] = [],
): Draft {
  const who = senderOf(email, sender)
  return {
    to: who.address,
    subject: prefixOnce(email.subject, 'Re'),
    body: quote(email, who),
    from: deliveredTo(email, self),
    inReplyTo: email.messageId,
    references: threadRefs(email),
  }
}

/**
 * Reply to everyone still on the thread.
 *
 * `self` is every address that belongs to this user; without it the sender
 * copies themselves on every reply. Comparison is case-insensitive because
 * the domain part of an address is, and in practice the local part is treated
 * that way by every mail host this bridges to.
 */
export function replyAllDraft(email: Email, self: string[], sender?: MailAddress): Draft {
  const who = senderOf(email, sender)
  const mine = new Set(self.map((a) => a.trim().toLowerCase()).filter(Boolean))
  const seen = new Set<string>()
  const recipients: string[] = []

  for (const { address } of [who, ...email.to, ...(email.cc ?? [])]) {
    const key = address.trim().toLowerCase()
    if (!key || mine.has(key) || seen.has(key)) continue
    seen.add(key)
    recipients.push(address)
  }

  return { ...replyDraft(email, who, self), to: recipients.join(', ') }
}

/**
 * Forwarding starts a new thread, so it deliberately carries no In-Reply-To or
 * References — attaching them would splice the forward into the original
 * conversation in the recipient's client.
 */
export function forwardDraft(email: Email, sender?: MailAddress): Draft {
  const who = senderOf(email, sender)
  const header = [
    '---------- Forwarded message ----------',
    `From: ${who.name ? `${who.name} <${who.address}>` : who.address}`,
    `Date: ${new Date(email.timestamp * 1000).toLocaleString()}`,
    `Subject: ${email.subject}`,
    `To: ${email.to.map((a) => a.address).join(', ')}`,
  ].join('\n')

  return {
    to: '',
    subject: prefixOnce(email.subject, 'Fwd'),
    body: `\n\n${header}\n\n${email.body}`,
  }
}
