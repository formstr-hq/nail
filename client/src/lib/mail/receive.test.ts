import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { buildMailRumor, sealAndWrap, keySigner } from '@protocol'
import { decodeGiftWrap } from './receive'
import { clearProbeCache } from '@/lib/nostr/nip05'

// The sender-proof branches are what the mailbox shows the reader, so the
// wraps here are built through the real protocol module rather than mocked —
// a stubbed seal would not exercise the pubkey comparisons that matter.

// Kind-0 lookups are the fallback path for an unproved sender. Relays are not
// reachable from the test env; stub the module so that path resolves instantly
// instead of waiting out its 2.5s query window.
vi.mock('@/lib/nostr/profile', () => ({
  fetchProfileName: vi.fn(async () => null),
  clearProfileCache: vi.fn(),
}))

const ME_SK = generateSecretKey()
const ME = getPublicKey(ME_SK)
const SENDER_SK = generateSecretKey()
const SENDER = getPublicKey(SENDER_SK)
const BRIDGE_SK = generateSecretKey()
const BRIDGE = getPublicKey(BRIDGE_SK)

function rfc2822(from: string | null) {
  return [
    ...(from ? [`From: ${from}`] : []),
    `To: me@mailstr.app`,
    `Subject: Seal timestamps drift on the bridge`,
    `Message-ID: <abc@mailstr.app>`,
    ``,
    `The kind 13 seal is using created_at from the outer wrapper.`,
  ].join('\r\n')
}

/** A wrap addressed to ME, sealed by `sealerSk`. */
async function wrapFrom(sealerSk: Uint8Array, from: string | null, extraTags: string[][] = []) {
  const sealer = getPublicKey(sealerSk)
  const rumor = buildMailRumor({
    senderPubkey: sealer,
    recipientPubkey: ME,
    rfc2822: rfc2822(from),
  })
  if (extraTags.length) {
    // The rumor id commits to its tags, so it has to be recomputed rather
    // than mutated in place — unwrapAndVerify checks it.
    rumor.tags = [...rumor.tags, ...extraTags]
    rumor.id = getEventHash(rumor)
  }
  return sealAndWrap(rumor, ME, keySigner(sealerSk))
}

function mockNip05(names: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ names }))))
}

beforeEach(() => clearProbeCache())
afterEach(() => vi.unstubAllGlobals())

describe('decodeGiftWrap sender proof', () => {
  // The bridge refuses to relay a From the sending key does not own, so its
  // seal is what makes an SMTP-side header believable.
  it('trusts the From header when the configured bridge sealed it', async () => {
    const wrap = await wrapFrom(BRIDGE_SK, 'Jack <jack@example.org>')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), BRIDGE, ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.senderProof).toBe('bridge-seal')
    expect(out.email.from.address).toBe('jack@example.org')
    expect(out.email.from.name).toBe('Jack')
  })

  it('marks our own outgoing copy as self-sealed', async () => {
    const wrap = await wrapFrom(ME_SK, 'me@mailstr.app')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), BRIDGE, ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.senderProof).toBe('own-seal')
    expect(out.email.from.address).toBe('me@mailstr.app')
  })

  // Same proof the bridge performs, done here directly.
  it("accepts the header when the address's NIP-05 resolves to the sealing key", async () => {
    mockNip05({ alice: SENDER })
    const wrap = await wrapFrom(SENDER_SK, 'alice@example.org')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), BRIDGE, ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.senderProof).toBe('nip05')
    expect(out.email.from.address).toBe('alice@example.org')
  })

  // The spoofing case: anyone may gift-wrap a message claiming to be someone
  // else. Nothing backs the header, so the sealing key is shown instead.
  it('falls back to the sealing key when NIP-05 names a different key', async () => {
    mockNip05({ alice: 'f'.repeat(64) })
    const wrap = await wrapFrom(SENDER_SK, 'alice@example.org')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), BRIDGE, ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.senderProof).toBe('none')
    expect(out.email.from.address).toBe(nip19.npubEncode(SENDER))
  })

  it('reports no proof when the message carries no From header', async () => {
    mockNip05({})
    const wrap = await wrapFrom(SENDER_SK, null)
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), BRIDGE, ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.senderProof).toBe('none')
    expect(out.email.from.address).toBe(nip19.npubEncode(SENDER))
  })

  // Regression: the client used to read only the RFC 2822 body, so every
  // Blossom-hosted attachment the bridge sent was dropped without a trace.
  it('surfaces Blossom-hosted attachments carried in imeta tags', async () => {
    const wrap = await wrapFrom(BRIDGE_SK, 'jack@example.org', [
      [
        'imeta',
        'url https://blossom.example/abc',
        'filename relay-trace.log',
        'm text/plain',
        'decryption-key ' + 'a'.repeat(64),
        'decryption-nonce ' + 'b'.repeat(24),
      ],
    ])
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), BRIDGE, ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.attachments).toHaveLength(1)
    const [attachment] = out.email.attachments
    expect(attachment.filename).toBe('relay-trace.log')
    expect(attachment.contentType).toBe('text/plain')
    expect(attachment.blossomUrl).toBe('https://blossom.example/abc')
    expect(attachment.blossomKey).toBe('a'.repeat(64))
    expect(attachment.blossomNonce).toBe('b'.repeat(24))
    // Nothing is fetched at decode time, so the size is genuinely unknown.
    expect(attachment.size).toBeUndefined()
  })

  it('reports no attachments when the message carries none', async () => {
    mockNip05({})
    const wrap = await wrapFrom(SENDER_SK, 'alice@example.org')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), BRIDGE, ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.attachments).toEqual([])
  })

  // With no bridge configured there is no key whose seal confers trust, so a
  // header must never be believed on the strength of a seal alone.
  it('does not confer bridge trust when no bridge is configured', async () => {
    mockNip05({})
    const wrap = await wrapFrom(BRIDGE_SK, 'jack@example.org')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), null, ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.senderProof).toBe('none')
    expect(out.email.from.address).toBe(nip19.npubEncode(BRIDGE))
  })
})
