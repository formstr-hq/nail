import type { Event } from 'nostr-tools'
import { buildMailRumor, sealAndWrap, bytesToMessageString, type ProtocolSigner } from '@protocol'
import { fetchDmRelays, publishToRelays } from '@/lib/nostr/relays'
import { buildRfc2822 } from './rfc2822'
import { resolveRecipients, type ResolveContext } from './resolve'
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
  ctx: ResolveContext
  signer: ProtocolSigner
}

/**
 * Build every gift wrap this message needs.
 *
 * Split out from sendMail so the wire format is testable without relays.
 *
 * One wrap per Nostr recipient; exactly ONE wrap to the bridge carrying every
 * legacy recipient as a `deliver` tag; one wrap to self, which becomes the
 * Sent entry. The single bridge wrap matters: sending one per legacy recipient
 * made the bridge deliver N copies to the first address and none to the rest.
 */
export async function buildWraps(
  params: SendMailParams,
): Promise<{ wraps: Event[]; targets: string[]; errors: string[] }> {
  const { from, senderPubkey, to, cc = [], ctx, signer } = params

  const toOut = await resolveRecipients(to, ctx)
  const ccOut = await resolveRecipients(cc, ctx)
  const errors = [...toOut.errors, ...ccOut.errors]
  if (errors.length) return { wraps: [], targets: [], errors }

  const headerList = (o: typeof toOut) => [
    ...o.nostr.map((r) => ({ address: r.headerAddress })),
    ...o.legacy.map((address) => ({ address })),
  ]

  const rfc2822 = buildRfc2822({
    from,
    to: headerList(toOut),
    cc: cc.length ? headerList(ccOut) : undefined,
    subject: params.subject,
    body: params.body,
    bodyHtml: params.bodyHtml,
    inReplyTo: params.inReplyTo,
    references: params.references,
  })

  // §4 "Content is a byte string": the rumor carries the message as one code
  // unit per octet, so the far side can recover the exact bytes. We compose in
  // UTF-8 and declare that charset, so encode here rather than shipping the
  // JS string, whose non-ASCII characters are multi-byte.
  const content = bytesToMessageString(new TextEncoder().encode(rfc2822))

  const wraps: Event[] = []
  const targets: string[] = []

  const add = async (recipientPubkey: string, deliverTo?: string[]) => {
    const rumor = buildMailRumor({ senderPubkey, recipientPubkey, rfc2822: content, deliverTo })
    wraps.push(await sealAndWrap(rumor, recipientPubkey, signer))
    targets.push(recipientPubkey)
  }

  for (const r of [...toOut.nostr, ...ccOut.nostr]) await add(r.pubkey)

  const legacy = [...toOut.legacy, ...ccOut.legacy]
  if (legacy.length) {
    if (!ctx.bridgePubkey) {
      return {
        wraps: [],
        targets: [],
        errors: ['No bridge configured — set your outbound bridge in Settings'],
      }
    }
    await add(ctx.bridgePubkey, legacy)
  }

  await add(senderPubkey)

  return { wraps, targets, errors: [] }
}

export async function sendMail(params: SendMailParams): Promise<void> {
  const { wraps, targets, errors } = await buildWraps(params)
  if (errors.length) throw new Error(errors.join('; '))

  const undelivered: string[] = []

  await Promise.all(
    wraps.map(async (wrap, i) => {
      const pubkey = targets[i]
      const relays = await fetchDmRelays(pubkey)
      const { ok, failed } = await publishToRelays(relays, wrap)
      // A failed self-copy costs the Sent entry, not the delivery — don't
      // report the message as undelivered because of it.
      if (pubkey !== params.senderPubkey && !ok.length) {
        undelivered.push(`${pubkey.slice(0, 8)}… (${failed[0]?.error ?? 'no relay accepted it'})`)
      }
    }),
  )

  if (undelivered.length) {
    throw new Error(`Could not deliver to: ${undelivered.join('; ')}`)
  }
}
