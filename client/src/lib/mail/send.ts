import { getPool, fetchDmRelays } from '@/lib/nostr/relays'
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
    to: toResolved.map((r) => ({ address: r.address })),
    cc: ccResolved.length ? ccResolved.map((r) => ({ address: r.address })) : undefined,
    subject,
    body,
    bodyHtml,
    inReplyTo,
    references,
  })

  const pool = getPool()

  // Send a separate gift-wrapped event to each recipient
  await Promise.all(
    allResolved.map(async (recipient) => {
      const rumor = buildMailRumor(senderPubkey, recipient.pubkey, rfc2822)
      const wrapped = giftWrap(rumor, recipient.pubkey)
      const relays = await fetchDmRelays(recipient.pubkey)
      await Promise.all(relays.map((url) => pool.publish([url], wrapped)))
    }),
  )

  // Send a copy to self for Sent folder
  const selfRumor = buildMailRumor(senderPubkey, senderPubkey, rfc2822)
  const selfWrapped = giftWrap(selfRumor, senderPubkey)
  const selfRelays = await fetchDmRelays(senderPubkey)
  await Promise.all(selfRelays.map((url) => pool.publish([url], selfWrapped)))
}
