import type { Email } from '@/types/mail'

/** A compose window's starting contents. Used verbatim — no further munging. */
export interface Draft {
  to: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string[]
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

/** `> ` quoting, with an attribution line above it. */
function quote(email: Email): string {
  const when = new Date(email.timestamp * 1000).toLocaleString()
  const who = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address
  const quoted = email.body
    .trimEnd()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
  return `\n\nOn ${when}, ${who} wrote:\n${quoted}\n`
}

export function replyDraft(email: Email): Draft {
  return {
    to: email.from.address,
    subject: prefixOnce(email.subject, 'Re'),
    body: quote(email),
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
export function replyAllDraft(email: Email, self: string[]): Draft {
  const mine = new Set(self.map((a) => a.trim().toLowerCase()).filter(Boolean))
  const seen = new Set<string>()
  const recipients: string[] = []

  for (const { address } of [email.from, ...email.to, ...(email.cc ?? [])]) {
    const key = address.trim().toLowerCase()
    if (!key || mine.has(key) || seen.has(key)) continue
    seen.add(key)
    recipients.push(address)
  }

  return { ...replyDraft(email), to: recipients.join(', ') }
}

/**
 * Forwarding starts a new thread, so it deliberately carries no In-Reply-To or
 * References — attaching them would splice the forward into the original
 * conversation in the recipient's client.
 */
export function forwardDraft(email: Email): Draft {
  const header = [
    '---------- Forwarded message ----------',
    `From: ${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`,
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
