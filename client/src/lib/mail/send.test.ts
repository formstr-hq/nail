import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Event } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { keySigner, unwrapAndVerify, deliverTargets, messageStringToBytes } from '@protocol'
import { buildWraps } from './send'
import { clearProbeCache } from '@/lib/nostr/nip05'

const BRIDGE_SK = generateSecretKey()
const BRIDGE_PK = getPublicKey(BRIDGE_SK)
const ALICE_SK = generateSecretKey()
const ALICE_PK = getPublicKey(ALICE_SK)

const CTX = { localDomains: ['mailstr.app'], ownDomain: 'mailstr.app', bridgePubkey: BRIDGE_PK }

const ALICE_NPUB = nip19.npubEncode(ALICE_PK)

const base = {
  // Derived from the key, so ownership is provable without a lookup — keeps
  // the bulk of these tests independent of the NIP-05 stub.
  from: { address: `${ALICE_NPUB}@mailstr.app` },
  senderPubkey: ALICE_PK,
  subject: 'hi',
  body: 'hello',
  ctx: CTX,
  signer: keySigner(ALICE_SK),
}

const toBridge = (wraps: Event[]) =>
  wraps.filter((w) => w.tags.some((t) => t[0] === 'p' && t[1] === BRIDGE_PK))

beforeEach(() => {
  clearProbeCache()
  vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ names: {} }))))
})
afterEach(() => vi.unstubAllGlobals())

describe('buildWraps', () => {
  // Three legacy recipients previously produced three wraps to the same bridge
  // pubkey, and the bridge read only To[0] — so #1 got three copies and #2/#3
  // got none. One wrap, three deliver tags.
  it('sends ONE bridge wrap carrying every legacy recipient', async () => {
    const { wraps } = await buildWraps({
      ...base,
      to: ['b@example.org', 'c@example.net', 'd@example.com'],
    })

    const bridgeWraps = toBridge(wraps)
    expect(bridgeWraps).toHaveLength(1)

    const result = await unwrapAndVerify(bridgeWraps[0], keySigner(BRIDGE_SK))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(deliverTargets(result.rumor)).toEqual([
      'b@example.org',
      'c@example.net',
      'd@example.com',
    ])
  })

  it('always includes a self-copy for the Sent folder', async () => {
    const { wraps } = await buildWraps({ ...base, to: ['b@example.org'] })
    expect(wraps.some((w) => w.tags.some((t) => t[0] === 'p' && t[1] === ALICE_PK))).toBe(true)
  })

  // The bridge authorizes against the seal pubkey, so an unsealed or
  // wrongly-sealed wrap would be rejected as unauthorized.
  it('seals with the sender key so the bridge can authorize', async () => {
    const { wraps } = await buildWraps({ ...base, to: ['b@example.org'] })
    const result = await unwrapAndVerify(toBridge(wraps)[0], keySigner(BRIDGE_SK))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.seal.pubkey).toBe(ALICE_PK)
  })

  // §4: content is a byte string, so the bridge can recover the exact octets.
  it('encodes content as a byte string the bridge can decode back to UTF-8', async () => {
    const { wraps } = await buildWraps({
      ...base,
      subject: 'café',
      body: 'café 日本',
      to: ['b@example.org'],
    })
    const result = await unwrapAndVerify(toBridge(wraps)[0], keySigner(BRIDGE_SK))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Every code unit must be a single octet — that is what makes it a byte
    // string rather than ordinary JS text.
    for (const ch of result.rumor.content) expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0xff)

    const decoded = new TextDecoder().decode(messageStringToBytes(result.rumor.content))
    expect(decoded).toContain('café 日本')
  })

  // Any account could otherwise put support@mailstr.app in From. Sent from
  // the real MX it passes SPF, DKIM and DMARC, so it lands in the recipient's
  // inbox fully authenticated — using the domain's own reputation to phish.
  it('refuses a From address the sending key does not own', async () => {
    const { wraps, errors } = await buildWraps({
      ...base,
      from: { address: 'support@mailstr.app' }, // unregistered, not ours
      to: ['b@example.org'],
    })
    expect(wraps).toEqual([])
    expect(errors[0]).toContain('support@mailstr.app')
  })

  it('refuses another user\'s registered address', async () => {
    const bobPk = getPublicKey(generateSecretKey())
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(JSON.stringify({ names: { bob: bobPk } }))),
    )
    const { wraps, errors } = await buildWraps({
      ...base,
      from: { address: 'bob@mailstr.app' },
      to: ['b@example.org'],
    })
    expect(wraps).toEqual([])
    expect(errors[0]).toContain('bob@mailstr.app')
  })

  it('accepts a named address whose NIP-05 record matches the sending key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(JSON.stringify({ names: { alice: ALICE_PK } }))),
    )
    const { wraps, errors } = await buildWraps({
      ...base,
      from: { address: 'alice@mailstr.app' },
      to: ['b@example.org'],
    })
    expect(errors).toEqual([])
    expect(wraps.length).toBeGreaterThan(0)
  })

  it('surfaces resolution errors instead of sending', async () => {
    const { wraps, errors } = await buildWraps({ ...base, to: ['ghost@mailstr.app'] })
    expect(errors[0]).toContain('ghost@mailstr.app')
    expect(wraps).toEqual([])
  })

  it('produces no bridge wrap when every recipient is Nostr-native', async () => {
    // Must be a real curve point: sealing performs an ECDH against it.
    const bobPk = getPublicKey(generateSecretKey())
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(JSON.stringify({ names: { bob: bobPk } }))),
    )
    const { wraps } = await buildWraps({ ...base, to: ['bob@mailstr.app'] })
    expect(toBridge(wraps)).toHaveLength(0)
    // recipient + self
    expect(wraps).toHaveLength(2)
  })
})
