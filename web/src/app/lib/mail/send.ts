import { nip19 } from 'nostr-tools'
import { generateSecretKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools'
import {
  buildMailRumor,
  sealAndWrap,
  bytesToMessageString,
  isNpub,
  splitAddress,
  type ProtocolSigner,
} from '@protocol'
import { fetchDmRelays } from '@/app/lib/nostr/relays'
import { getLocalRelay } from '@/app/lib/nostr/localRelay'
import { probeNip05 } from '@/app/lib/nostr/nip05'
import { buildRfc2822 } from './rfc2822'
import { resolveRecipients, type ResolveContext } from './resolve'
import type { MailAddress } from '@/app/types/mail'
import type { PgpSettings } from '@/app/lib/pgp/keyring'
import { keyForAddress } from '@/app/lib/pgp/keyring'

/**
 * Does the signing key actually own the address it wants to send as?
 *
 * This is the ownership check for the *direct* (Nostr-native) path: a From the
 * key does not own would display as unverified to Nostr recipients, which is
 * confusing rather than informative. The npub shortcut is intentional here —
 * an npub address IS the key, so ownership is provable without a lookup, and
 * the npub is a legitimate sender for internal mail.
 *
 * It is deliberately NOT the bridge authorization. The bridge rejects any From
 * that is not a registered NIP-05 alias, including the npub, so mirroring it
 * here would forbid the legal npub-to-internal case. The bridge path has its
 * own guard in `buildWraps` (see the `legacy.length` branch), which replays
 * `authorizeSender` exactly — no npub shortcut — and only when there are
 * external recipients that actually require the bridge.
 *
 * UX guard, not the security boundary. The bridge enforces against
 * `seal.pubkey`, the only version an attacker cannot route around; a modified
 * client can skip this entirely.
 */
async function senderOwnsFromAddress(from: string, senderPubkey: string): Promise<boolean> {
  const parts = splitAddress(from)
  if (!parts) return false

  // `<npub>@<domain>` is derived from the key itself, so ownership is provable
  // locally — no lookup, and it works before any name has been registered.
  if (isNpub(parts.localpart)) {
    try {
      return (nip19.decode(parts.localpart).data as string) === senderPubkey
    } catch {
      return false
    }
  }

  return (await probeNip05(from)) === senderPubkey
}

// The bridge relays outbound legacy mail only for a registered NIP-05 alias
// sender, never a bare npub. The message and its matcher live together so the
// composer can recognize *this* failure among all send errors and offer the
// fix — switch to an owned alias, or buy one — instead of just printing the
// sentence. Keep the shared phrase in both so copy edits stay in step.
const UNREGISTERED_SENDER_PHRASE = 'registered alias senders'

export function unregisteredSenderError(fromAddress: string, domains: string[]): string {
  return (
    `External recipients are delivered through the bridge, which only accepts ` +
    `${UNREGISTERED_SENDER_PHRASE} on ${domains.join('/')}. ` +
    `"${fromAddress}" is not one, so the bridge would bounce this message. ` +
    `Use a registered alias as the From, or remove the external recipients.`
  )
}

/** True when a send error is the unregistered-sender bounce above — the one
 *  case the composer can offer a one-click fix for. */
export function isUnregisteredSenderError(message: string): boolean {
  return message.includes(UNREGISTERED_SENDER_PHRASE)
}

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
  /** PGP key maps, when the user wants encryption considered for legacy mail. */
  pgp?: PgpSettings
}

/**
 * Build every gift wrap this message needs.
 *
 * Split out from sendMail so the wire format is testable without relays.
 *
 * One wrap per Nostr recipient; ONE wrap per legacy delivery MODE to the bridge
 * (see the mixed-encryption note at `buildLegacyWraps`); one wrap to self,
 * which becomes the Sent entry.
 */
export async function buildWraps(
  params: SendMailParams,
): Promise<{ wraps: Event[]; targets: string[]; errors: string[] }> {
  const { from, senderPubkey, to, cc = [], ctx, signer } = params

  // Refuse before anything is published. Sending as an address you do not own
  // would be rejected by the bridge anyway, but only after a round trip — and
  // for Nostr-native recipients it would simply display as unverified, which
  // is confusing rather than informative.
  if (!(await senderOwnsFromAddress(from.address, senderPubkey))) {
    return {
      wraps: [],
      targets: [],
      errors: [
        `You do not own "${from.address}", so it cannot be used as the From address. ` +
          `Pick one of your own addresses in Settings.`,
      ],
    }
  }

  const toOut = await resolveRecipients(to, ctx)
  const ccOut = await resolveRecipients(cc, ctx)
  const errors = [...toOut.errors, ...ccOut.errors]
  if (errors.length) return { wraps: [], targets: [], errors }

  // Dedup on resolved routing, not input text: the same mailbox can arrive as
  // an npub and a hex key, and a To+Cc overlap lists the same person twice.
  // Without this the recipient gets two identical wraps (one delivery each).
  const seenNostr = new Set<string>()
  const nostrTargets = [...toOut.nostr, ...ccOut.nostr].filter((r) => {
    if (seenNostr.has(r.pubkey)) return false
    seenNostr.add(r.pubkey)
    return true
  })
  const seenLegacy = new Set<string>()
  const legacy = [...toOut.legacy, ...ccOut.legacy].filter((address) => {
    const key = address.trim().toLowerCase()
    if (seenLegacy.has(key)) return false
    seenLegacy.add(key)
    return true
  })

  // Headers must match the deduped routing: a recipient present in both To and
  // Cc appears once in the wrap, so it must appear once in the document too (To
  // wins). Otherwise the reader sees a duplicate address with no second copy.
  const inHeaders = new Set<string>()
  const headerFor = (address: string) => {
    const key = address.trim().toLowerCase()
    if (inHeaders.has(key)) return false
    inHeaders.add(key)
    return true
  }
  const headerList = (o: typeof toOut) =>
    [...o.nostr.map((r) => r.headerAddress), ...o.legacy]
      .filter(headerFor)
      .map((address) => ({ address }))

  const fullTo = headerList(toOut)
  const ccHeaders = cc.length ? headerList(ccOut) : []
  // Undefined rather than empty: a Cc header listing nobody (every address was
  // already in To) should not be emitted at all.
  const fullCc = ccHeaders.length ? ccHeaders : undefined

  const rfc2822 = buildRfc2822({
    from,
    to: fullTo,
    cc: fullCc,
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

  const add = async (recipientPubkey: string, deliverTo?: string[], rfcOverride?: string) => {
    // One ephemeral key per wrap, generated first and shared between the rumor
    // (WRAP_KEY_TAG — what makes the recipient's "delete forever" real) and the
    // wrap signature. Splitting them hands the recipient a useless key.
    const ephemeralSk = generateSecretKey()
    const rumor = buildMailRumor({
      senderPubkey,
      recipientPubkey,
      rfc2822: rfcOverride ?? content,
      deliverTo,
      wrapSecret: ephemeralSk,
    })
    wraps.push(await sealAndWrap(rumor, recipientPubkey, signer, { ephemeralSk }))
    targets.push(recipientPubkey)
  }

  for (const r of nostrTargets) await add(r.pubkey)

  if (legacy.length) {
    if (!ctx.bridgePubkey) {
      return {
        wraps: [],
        targets: [],
        errors: ['No bridge configured — set your outbound bridge in Settings'],
      }
    }
    // Replay the bridge's authorizeSender (outbound.ts) before publishing: the
    // From domain must be one this bridge serves, and the address must resolve
    // over NIP-05 to the sender's key. An npub From is provably *owned* by this
    // key (see senderOwnsFromAddress above) but is not a NIP-05 name the bridge
    // resolves, so mail to external recipients from an npub From is silently
    // bounced with a postmaster "does not exist" reply. Catch it here so the
    // user gets a clear message instead. No npub shortcut on this path: it
    // must match the bridge exactly. Mail to local (Nostr-direct) recipients
    // never reaches this branch, so an npub From stays legal for internal mail.
    const fromParts = splitAddress(from.address)
    if (
      !fromParts ||
      !ctx.localDomains.includes(fromParts.domain) ||
      (await probeNip05(from.address)) !== senderPubkey
    ) {
      return {
        wraps: [],
        targets: [],
        errors: [unregisteredSenderError(from.address, ctx.localDomains)],
      }
    }

    // MIXED encryption for legacy recipients: those we hold a key for get a
    // PGP-encrypted RFC 2822 document; the rest go out as plaintext. Each mode
    // rides its own bridge wrap (one wrap per mode, NOT per recipient — the
    // bridge expands `deliver` tags), and each document carries the FULL
    // To/Cc header lists so every recipient sees the complete audience,
    // including those who received it in the other form — the standard
    // "you were BCC'd by encryption" transparency a mixed send must preserve.
    const pgp = params.pgp
    const encryptable = pgp ? legacy.filter((a) => !!keyForAddress(pgp, a)) : []
    const plaintext = pgp ? legacy.filter((a) => !keyForAddress(pgp, a)) : legacy

    let encryptedRfc: string | undefined
    if (encryptable.length && params.pgp) {
      try {
        const { encryptBody } = await import('@/app/lib/pgp/compose')
        const armored = await encryptBody({
          body: params.body,
          fromAddress: from.address,
          recipients: encryptable,
          settings: params.pgp,
        })
        encryptedRfc = bytesToMessageString(
          new TextEncoder().encode(
            buildRfc2822({
              from,
              to: fullTo,
              cc: fullCc,
              subject: params.subject,
              body: armored,
              inReplyTo: params.inReplyTo,
              references: params.references,
            }),
          ),
        )
      } catch {
        // Encryption failed for an unexpected reason — demote the whole
        // encryptable set to plaintext rather than dropping the message.
        // Rare: keys existed, so this is only malformed key material.
        plaintext.push(...encryptable)
        encryptable.length = 0
        encryptedRfc = undefined
      }
    }

    // Encrypted document first: its recipients get ciphertext, and the document
    // lists the full audience. The plaintext wrap (when any) follows with the
    // same full headers.
    if (encryptable.length && encryptedRfc) {
      await add(ctx.bridgePubkey, encryptable, encryptedRfc)
    }
    if (plaintext.length) {
      await add(ctx.bridgePubkey, plaintext)
    }
  }

  await add(senderPubkey)

  return { wraps, targets, errors: [] }
}

export async function sendMail(params: SendMailParams): Promise<void> {
  const { wraps, targets, errors } = await buildWraps(params)
  if (errors.length) throw new Error(errors.join('; '))

  const relay = getLocalRelay()
  const undelivered: string[] = []

  await Promise.all(
    wraps.map(async (wrap, i) => {
      const pubkey = targets[i]
      // Resolve the recipient's NIP-17 DM inbox (kind 10050) and hand it to the
      // worker as an explicit target — it can't discover an arbitrary pubkey's
      // inbox on its own. The worker stores the wrap, publishes it, and keeps
      // re-delivering to any relay that didn't accept (durable outbox), so a
      // transient relay outage no longer silently drops the message.
      const relays = await fetchDmRelays(pubkey)
      const outcomes = await relay.publish(wrap, { relays })
      const accepted = outcomes.some((o) => o.status === 'accepted')
      // A failed self-copy costs the Sent entry, not the delivery — don't
      // report the message as undelivered because of it.
      if (pubkey !== params.senderPubkey && !accepted) {
        const reason = outcomes.find((o) => o.message)?.message ?? 'no relay accepted it'
        undelivered.push(`${pubkey.slice(0, 8)}… (${reason})`)
      }
    }),
  )

  if (undelivered.length) {
    throw new Error(`Could not deliver to: ${undelivered.join('; ')}`)
  }
}
