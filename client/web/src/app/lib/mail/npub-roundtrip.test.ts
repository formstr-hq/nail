import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { keySigner } from '@protocol'
import { buildWraps } from './send'
import { decodeGiftWrap } from './receive'

vi.mock('@/lib/nostr/profile', () => ({
  fetchProfileName: vi.fn(async () => null),
  clearProfileCache: vi.fn(),
}))

const SENDER_SK = generateSecretKey()
const SENDER = getPublicKey(SENDER_SK)
const RECIP_SK = generateSecretKey()
const RECIP = getPublicKey(RECIP_SK)

const CTX = { localDomains: ['mailstr.app'], ownDomain: 'mailstr.app', bridgePubkey: null }

describe('npub → npub direct mail', () => {
  it('carries the body through send and decode', async () => {
    const from = { address: `${nip19.npubEncode(SENDER)}@mailstr.app` }
    const { wraps, targets, errors } = await buildWraps({
      from,
      senderPubkey: SENDER,
      to: [nip19.npubEncode(RECIP)],
      subject: 'hello there',
      body: 'This is the body of a direct npub-to-npub message.',
      ctx: CTX,
      signer: keySigner(SENDER_SK),
    })
    expect(errors).toEqual([])
    // Find the wrap addressed to the recipient (not the self-copy).
    const idx = targets.indexOf(RECIP)
    expect(idx).toBeGreaterThanOrEqual(0)

    const out = await decodeGiftWrap(wraps[idx], keySigner(RECIP_SK), null, RECIP)
    expect('email' in out).toBe(true)
    if ('email' in out) {
      expect(out.email.subject).toBe('hello there')
      expect(out.email.body).toContain('This is the body')
    }
  })
})

// A kind-1301 rumor whose content is NOT well-formed RFC2822 — a bare line with
// no header/body separator. Before the fix this decoded to an empty body ("no
// content"); now the raw content is surfaced so nothing is lost.
describe('non-RFC2822 mail content', () => {
  it.each([
    ['single line', 'hey, are we still on for tomorrow?'],
    ['multi line', 'hey there\n\nhow are you doing today?'],
    ['looks-like-header', 'Re: dinner tonight?'],
  ])('recovers the body of a bare-text rumor (%s)', async (_label, content) => {
    const { buildMailRumor, sealAndWrap, keySigner } = await import('@protocol')
    const { decodeGiftWrap } = await import('./receive')
    const wrap = await sealAndWrap(
      buildMailRumor({ senderPubkey: SENDER, recipientPubkey: RECIP, rfc2822: content }),
      RECIP,
      keySigner(SENDER_SK),
    )
    const out = await decodeGiftWrap(wrap, keySigner(RECIP_SK), null, RECIP)
    expect('email' in out).toBe(true)
    if ('email' in out) {
      // Every character the sender wrote is present, not dropped as a bogus header.
      expect(out.email.body).toBe(content)
      expect(out.email.bodyHtml).toBeUndefined()
    }
  })
})
