import { fetchDmRelays, publishToRelays } from '@/lib/nostr/relays'
import { buildMailRumor, giftWrap } from '@/lib/nostr/giftwrap'
import { buildRfc2822 } from './rfc2822'
import { resolveRecipient } from './resolve'
import type { MailAddress } from '@/types/mail'

export interface SendMailParams {
  from: MailAddress
  senderPubkey: string
  to: string[]
  cc?: string[]
  subject: string
  body: string
  bodyHtml?: string
  inReplyTo?: string
  references?: string[]
}

export async function sendMail(params: SendMailParams): Promise<void> {
  const { from, senderPubkey, to, cc = [], subject, body, bodyHtml, inReplyTo, references } = params

  // Resolve all recipients
  const toResolved = await Promise.all(to.map(resolveRecipient))
  const ccResolved = await Promise.all(cc.map(resolveRecipient))
  const allResolved = [...toResolved, ...ccResolved]

  // Build the RFC 2822 email once (BCC stripped from headers before sending)
  const rfc2822 = buildRfc2822({
    from,
    to: toResolved.map((r) => ({ address: r.headerAddress })),
    cc: ccResolved.length ? ccResolved.map((r) => ({ address: r.headerAddress })) : undefined,
    subject,
    body,
    bodyHtml,
    inReplyTo,
    references,
  })

  // One gift-wrapped event per recipient, plus a copy to self that becomes the
  // Sent entry. These are independent, so publish them concurrently rather
  // than making the user wait for each relay round-trip in turn.
  const undelivered: string[] = []

  const deliverTo = async (pubkey: string, label: string | null) => {
    const rumor = buildMailRumor(senderPubkey, pubkey, rfc2822)
    const wrapped = giftWrap(rumor, pubkey)
    const relays = await fetchDmRelays(pubkey)
    const { ok, failed } = await publishToRelays(relays, wrapped)

    // A recipient whose relays all refused the wrap has NOT received the mail.
    // Surface that instead of reporting a send that went nowhere.
    if (label && !ok.length) {
      undelivered.push(`${label} (${failed[0]?.error ?? 'no relay accepted the message'})`)
    }
  }

  await Promise.all([
    ...allResolved.map((r) => deliverTo(r.pubkey, r.address)),
    deliverTo(senderPubkey, null),
  ])

  if (undelivered.length) {
    throw new Error(`Could not deliver to: ${undelivered.join('; ')}`)
  }
}
