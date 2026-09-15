import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools/pure'
import { buildMailRumor, sealAndWrap, keySigner } from '@protocol'
import { decodeGiftWrap } from './receive'
import { clearProbeCache } from '@/app/lib/nostr/nip05'

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

/** An RFC 3156 PGP/MIME message: control + octet-stream data parts. */
function rfc2822PgpMime(from: string) {
  const boundary = 'pgpmime-boundary'
  return [
    `From: ${from}`,
    `To: me@mailstr.app`,
    `Subject: encrypted note`,
    `Message-ID: <pgpmime@mailstr.app>`,
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
    ``,
    `This is an OpenPGP/MIME encrypted message.`,
    `--${boundary}`,
    `Content-Type: application/pgp-encrypted`,
    ``,
    `Version: 1`,
    ``,
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="encrypted.asc"`,
    ``,
    `-----BEGIN PGP MESSAGE-----`,
    ``,
    `deadbeef==`,
    `-----END PGP MESSAGE-----`,
    ``,
    `--${boundary}--`,
    ``,
  ].join('\r\n')
}

/** Like `wrapFrom`, but carries a real RFC 3156 PGP/MIME body. */
async function wrapPgpMimeFrom(sealerSk: Uint8Array, from: string) {
  const sealer = getPublicKey(sealerSk)
  const rumor = buildMailRumor({
    senderPubkey: sealer,
    recipientPubkey: ME,
    rfc2822: rfc2822PgpMime(from),
  })
  return sealAndWrap(rumor, ME, keySigner(sealerSk))
}

function mockNip05(names: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ names }))))
}

beforeEach(() => clearProbeCache())
afterEach(() => vi.unstubAllGlobals())

describe('decodeGiftWrap stores raw sender facts, not a proof verdict', () => {
  // Decode must NOT decide whether the header is believable: bridge resolution
  // is asynchronous and can land after this message is on screen. It keeps the
  // claimed header plus the sealing key; the proof is derived at render time
  // (see senderProof.test.ts, which covers every verdict including the
  // checking -> bridge-seal flip this change exists for).
  it('keeps the claimed From header verbatim alongside the sealing key', async () => {
    const wrap = await wrapFrom(BRIDGE_SK, 'Jack <jack@example.org>')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.fromHeader.address).toBe('jack@example.org')
    expect(out.email.fromHeader.name).toBe('Jack')
    expect(out.email.senderPubkey).toBe(BRIDGE)
  })

  it('keeps a header nothing backs too — refusal to display it is render-time', async () => {
    const wrap = await wrapFrom(SENDER_SK, 'ceo@company.com')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.fromHeader.address).toBe('ceo@company.com')
    expect(out.email.senderPubkey).toBe(SENDER)
  })

  it('records an empty claim when the message carries no From header', async () => {
    const wrap = await wrapFrom(SENDER_SK, null)
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.fromHeader.address).toBe('')
    expect(out.email.senderPubkey).toBe(SENDER)
  })

  // The derivation is what must produce each verdict. Keeping these cases here
  // as integration assertions guards that decode + derive compose correctly;
  // the branch-by-branch coverage lives in senderProof.test.ts.
  it('derives each proof from the stored facts', async () => {
    const { deriveSenderProof } = await import('./senderProof')

    const bridgeWrap = await wrapFrom(BRIDGE_SK, 'jack@example.org')
    const bridgeOut = await decodeGiftWrap(bridgeWrap, keySigner(ME_SK), ME)
    expect('email' in bridgeOut).toBe(true)
    if (!('email' in bridgeOut)) return
    expect(
      deriveSenderProof({
        fromHeader: bridgeOut.email.fromHeader,
        sealPubkey: bridgeOut.email.senderPubkey,
        ownPubkey: ME,
        bridges: [
          {
            target: '_smtp@mailstr.app',
            label: 'mailstr.app',
            isDefault: true,
            status: 'resolved',
            pubkey: BRIDGE,
          },
        ],
        nip05: { status: 'resolved', pubkey: null },
      }),
    ).toBe('bridge-seal')

    // Same message, bridge not resolved yet: checking, never a frozen `none`.
    expect(
      deriveSenderProof({
        fromHeader: bridgeOut.email.fromHeader,
        sealPubkey: bridgeOut.email.senderPubkey,
        ownPubkey: ME,
        bridges: [
          { target: '_smtp@mailstr.app', label: 'mailstr.app', isDefault: true, status: 'resolving' },
        ],
        nip05: { status: 'resolved', pubkey: null },
      }),
    ).toBe('checking')

    const ownWrap = await wrapFrom(ME_SK, 'me@mailstr.app')
    const ownOut = await decodeGiftWrap(ownWrap, keySigner(ME_SK), ME)
    expect('email' in ownOut).toBe(true)
    if (!('email' in ownOut)) return
    expect(
      deriveSenderProof({
        fromHeader: ownOut.email.fromHeader,
        sealPubkey: ownOut.email.senderPubkey,
        ownPubkey: ME,
        bridges: [],
        nip05: { status: 'skipped' },
      }),
    ).toBe('own-seal')

    mockNip05({ alice: SENDER })
    const directWrap = await wrapFrom(SENDER_SK, 'alice@example.org')
    const directOut = await decodeGiftWrap(directWrap, keySigner(ME_SK), ME)
    expect('email' in directOut).toBe(true)
    if (!('email' in directOut)) return
    const { probeNip05 } = await import('@/app/lib/nostr/nip05')
    const pubkey = await probeNip05('alice@example.org')
    expect(
      deriveSenderProof({
        fromHeader: directOut.email.fromHeader,
        sealPubkey: directOut.email.senderPubkey,
        ownPubkey: ME,
        bridges: [
          {
            target: '_smtp@mailstr.app',
            label: 'mailstr.app',
            isDefault: true,
            status: 'resolved',
            pubkey: BRIDGE,
          },
        ],
        nip05: { status: 'resolved', pubkey },
      }),
    ).toBe('nip05')
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
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), ME)

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
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.attachments).toEqual([])
  })

  // Regression: a standards-compliant PGP/MIME message (multipart/encrypted,
  // RFC 3156) has no `text` for postal-mime to hand back — the ciphertext
  // lives in an octet-stream data part instead. The client used to render
  // this as a blank email with two mystery attachments and never attempt
  // decryption, since `isPgpMessage` only ever looked at `email.body`.
  it('lifts an RFC 3156 PGP/MIME data part into the body as armor', async () => {
    mockNip05({})
    const wrap = await wrapPgpMimeFrom(SENDER_SK, 'alice@example.org')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    expect(out.email.body).toContain('-----BEGIN PGP MESSAGE-----')
    expect(out.email.body).toContain('-----END PGP MESSAGE-----')
    // The control + data parts are the message body, not attachments.
    expect(out.email.attachments).toEqual([])
  })

  // With no bridge configured there is no key whose seal confers trust, so a
  // header must never be believed on the strength of a seal alone. The verdict
  // is render-time now: an empty bridge list derives `checking` (a resolution
  // could still land) — never a trusted header.
  it('does not confer bridge trust when no bridge is configured', async () => {
    mockNip05({})
    const wrap = await wrapFrom(BRIDGE_SK, 'jack@example.org')
    const out = await decodeGiftWrap(wrap, keySigner(ME_SK), ME)

    expect(out).toHaveProperty('email')
    if (!('email' in out)) return
    const { deriveSenderProof, displaySender } = await import('./senderProof')
    const proof = deriveSenderProof({
      fromHeader: out.email.fromHeader,
      sealPubkey: out.email.senderPubkey,
      ownPubkey: ME,
      bridges: [],
      nip05: { status: 'resolved', pubkey: null },
    })
    expect(proof).toBe('checking')
    expect(displaySender(proof, { fromHeader: out.email.fromHeader, sealPubkey: BRIDGE }).address).toBe(
      out.email.fromHeader.address,
    )

    // And once resolution settles with no bridge, it is unavailable — not a
    // silently trusted header.
    expect(
      deriveSenderProof({
        fromHeader: out.email.fromHeader,
        sealPubkey: out.email.senderPubkey,
        ownPubkey: ME,
        bridges: [
          {
            target: '_smtp@mailstr.app',
            label: 'mailstr.app',
            isDefault: true,
            status: 'failed',
            message: 'no answer',
          },
        ],
        nip05: { status: 'resolved', pubkey: null },
      }),
    ).toBe('bridge-unavailable')
  })
})
describe('decodeGiftWrap failure taxonomy', () => {
  // A signer that times out is NOT "someone else's mail". Misclassifying it as
  // routine made the decode queue drop real mail with no retry or signal
  // (audit D3); the tagged signer failure must surface as retryable.
  it('classifies a signer failure as a retryable, non-routine failure', async () => {
    const { SignerError } = await import('@/app/lib/nostr/signer')
    const wrap = await wrapFrom(SENDER_SK, 'alice@example.org')
    const failingSigner = {
      ...keySigner(ME_SK),
      nip44Decrypt: async () => {
        throw new SignerError('Signer did not respond to "nip44Decrypt" within 20s.')
      },
    }

    const out = await decodeGiftWrap(wrap, failingSigner, ME)
    expect(out).toEqual({
      failure: { reason: 'signer-error', routine: false, retryable: true },
    })
  })

  it('still treats an undecryptable wrap as routine not-for-us', async () => {
    const wrap = await wrapFrom(SENDER_SK, 'alice@example.org')
    const otherSk = generateSecretKey()
    const out = await decodeGiftWrap(wrap, keySigner(otherSk), ME)
    expect(out).toEqual({ failure: { reason: 'not-for-us', routine: true, retryable: false } })
  })
})
