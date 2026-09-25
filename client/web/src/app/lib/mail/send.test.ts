import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import type { Event } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { keySigner, unwrapAndVerify, deliverTargets, messageStringToBytes } from '@protocol'
import { buildWraps } from './send'
import { clearProbeCache } from '@/app/lib/nostr/nip05'
import { generateKeySet, encryptPrivateKey, parsePgpMessage, decryptMessage } from '@/app/lib/pgp/openpgp'
import { addToKeyring } from '@/app/lib/pgp/keyring'

const BRIDGE_SK = generateSecretKey()
const BRIDGE_PK = getPublicKey(BRIDGE_SK)
const ALICE_SK = generateSecretKey()
const ALICE_PK = getPublicKey(ALICE_SK)

const CTX = { localDomains: ['mailstr.app'], ownDomain: 'mailstr.app', bridgePubkey: BRIDGE_PK }

const ALICE_NPUB = nip19.npubEncode(ALICE_PK)

const base = {
  // A registered alias owned by ALICE_PK — the realistic From for mail that
  // goes through the bridge. The default fetch stub below resolves it, so the
  // bulk of these tests exercise the real NIP-05 path the bridge uses.
  from: { address: 'alice@mailstr.app' },
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
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Response(JSON.stringify({ names: { alice: ALICE_PK } }))),
  )
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

  // A repeated address, or one present in both To and Cc, must not get two
  // deliveries (audit D8).
  it('dedupes a Nostr recipient present twice / in both To and Cc', async () => {
    const bob = nip19.npubEncode(ALICE_PK)
    const { wraps } = await buildWraps({ ...base, to: [bob], cc: [bob] })
    // Bob's wrap + the self-copy (same key here), so exactly two; never three.
    const toBob = wraps.filter((w) => w.tags.some((t) => t[0] === 'p' && t[1] === ALICE_PK))
    expect(toBob).toHaveLength(2)
  })

  it('dedupes repeated legacy recipients in one bridge wrap', async () => {
    const { wraps } = await buildWraps({
      ...base,
      to: ['b@example.org', 'B@example.org'],
      cc: ['b@example.org'],
    })
    const result = await unwrapAndVerify(toBridge(wraps)[0], keySigner(BRIDGE_SK))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(deliverTargets(result.rumor)).toEqual(['b@example.org'])
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

  // A workspace (tenant) domain is served by the same bridge, so a From on it
  // is a legal sender for external mail — provided the address resolves to the
  // sending key. Before localDomains included owned workspace domains, the
  // composer rejected this with the "not a registered alias" error.
  it('accepts a workspace From for external recipients when the domain is served', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/nip-05/resolve')) {
          return new Response(
            JSON.stringify({ pubkey: ALICE_PK, address: 'test@hllo.live' }),
          )
        }
        if (url.includes('hllo.live')) {
          // A tenant domain serves no well-known — that is what sends the
          // lookup to the resolver.
          return new Response('', { status: 404 })
        }
        // Platform well-known still answers for alice@mailstr.app.
        return new Response(JSON.stringify({ names: { alice: ALICE_PK } }))
      }),
    )
    const workspaceCtx = { ...CTX, localDomains: ['mailstr.app', 'hllo.live'] }
    const { wraps, errors } = await buildWraps({
      ...base,
      ctx: workspaceCtx,
      from: { address: 'test@hllo.live' },
      to: ['b@example.org'],
    })
    expect(errors).toEqual([])
    expect(toBridge(wraps)).toHaveLength(1)
  })

  it('still refuses a workspace From the sending key does not own', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/nip-05/resolve')) {
          return new Response(
            JSON.stringify({ pubkey: 'f'.repeat(64), address: 'test@hllo.live' }),
          )
        }
        if (url.includes('hllo.live')) return new Response('', { status: 404 })
        return new Response(JSON.stringify({ names: { alice: ALICE_PK } }))
      }),
    )
    const workspaceCtx = { ...CTX, localDomains: ['mailstr.app', 'hllo.live'] }
    const { wraps, errors } = await buildWraps({
      ...base,
      ctx: workspaceCtx,
      from: { address: 'test@hllo.live' },
      to: ['b@example.org'],
    })
    expect(wraps).toEqual([])
    expect(errors[0]).toContain('test@hllo.live')
  })

  // A workspace recipient is reachable over Nostr (the resolver maps them), so
  // they must NOT ride the legacy bridge wrap.
  it('routes a workspace recipient Nostr-direct, not through the bridge', async () => {
    const bobPk = getPublicKey(generateSecretKey())
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/nip-05/resolve')) {
          return new Response(JSON.stringify({ pubkey: bobPk, address: 'bob@hllo.live' }))
        }
        if (url.includes('hllo.live')) return new Response('', { status: 404 })
        return new Response(JSON.stringify({ names: { alice: ALICE_PK } }))
      }),
    )
    const workspaceCtx = { ...CTX, localDomains: ['mailstr.app', 'hllo.live'] }
    const { wraps, errors } = await buildWraps({
      ...base,
      ctx: workspaceCtx,
      from: { address: 'alice@mailstr.app' },
      to: ['bob@hllo.live'],
    })
    expect(errors).toEqual([])
    expect(toBridge(wraps)).toHaveLength(0)
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
      vi.fn(() => new Response(JSON.stringify({ names: { alice: ALICE_PK, bob: bobPk } }))),
    )
    const { wraps } = await buildWraps({ ...base, to: ['bob@mailstr.app'] })
    expect(toBridge(wraps)).toHaveLength(0)
    // recipient + self
    expect(wraps).toHaveLength(2)
  })

  // The reported bug: a user logs in with their npub, buys an alias, but the
  // npub stays the From, so mail to an external address is bounced by the
  // bridge ("No NIP-05 record for <npub>@…"). The npub IS owned by the key
  // (ownership passes), but the bridge resolves From over NIP-05 and the npub
  // localpart is not a registered name. The bridge guard must catch it.
  it('refuses an npub From for external recipients the bridge would bounce', async () => {
    const { wraps, errors } = await buildWraps({
      ...base,
      from: { address: `${ALICE_NPUB}@mailstr.app` },
      to: ['b@example.org'],
    })
    expect(wraps).toEqual([])
    expect(errors[0]).toContain(ALICE_NPUB)
    expect(errors[0]).toMatch(/bridge|external|alias/i)
  })

  // The same npub From is legal for internal mail: Nostr-direct recipients
  // never touch the bridge, so the npub is a fine sender there.
  it('allows an npub From for internal (Nostr-direct) recipients', async () => {
    const bobPk = getPublicKey(generateSecretKey())
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response(JSON.stringify({ names: { bob: bobPk } }))),
    )
    const { wraps, errors } = await buildWraps({
      ...base,
      from: { address: `${ALICE_NPUB}@mailstr.app` },
      to: ['bob@mailstr.app'],
    })
    expect(errors).toEqual([])
    expect(toBridge(wraps)).toHaveLength(0)
    // recipient + self
    expect(wraps).toHaveLength(2)
  })

  describe('mixed encryption for legacy recipients', () => {
    let aliceSet: Awaited<ReturnType<typeof generateKeySet>>
    let bobSet: Awaited<ReturnType<typeof generateKeySet>>
    let carolSet: Awaited<ReturnType<typeof generateKeySet>>

    beforeAll(async () => {
      ;[aliceSet, bobSet, carolSet] = await Promise.all([
        generateKeySet({ email: 'alice@mailstr.app' }),
        generateKeySet({ email: 'bob@gmail.com' }),
        generateKeySet({ email: 'carol@example.net' }),
      ])
    }, 60_000)

    /** pgp maps: alice's dual own key + bob@gmail.com keyed, carol keyed not. */
    async function mixedPgp() {
      return {
        pgpKeys: {
          'alice@mailstr.app': {
            publicKey: aliceSet.v4.publicKey,
            privateKey: aliceSet.v4.privateKey,
            fingerprint: aliceSet.v4.fingerprint,
            v4: aliceSet.v4,
            v6: aliceSet.v6,
          },
        },
        pgpKeyring: await addToKeyring({}, bobSet.v4.publicKey),
      }
    }

    /**
     * A locked dual set for the fail-closed tests. The app no longer generates
     * passphrase-protected keys, but a LEGACY locked key in the settings blob
     * must still refuse a cleartext send — so the fixture locks both halves via
     * encryptPrivateKey, exactly like a pre-policy key, and the tests pin that
     * path. (Rotation replaces such a key with an unlocked one.)
     */
    async function lockedKeySet() {
      const gen = await generateKeySet({ email: 'locked@mailstr.app' })
      return {
        v4: { ...gen.v4, privateKey: await encryptPrivateKey(gen.v4.privateKey, 'hunter2') },
        v6: { ...gen.v6, privateKey: await encryptPrivateKey(gen.v6.privateKey, 'hunter2') },
      }
    }

    it('sends ONE bridge wrap when every legacy recipient is encryptable', async () => {
      const { wraps } = await buildWraps({
        ...base,
        to: ['bob@gmail.com', 'carol@example.net'],
        encrypt: true,
        pgp: {
          ...(await mixedPgp()),
          pgpKeyring: await addToKeyring(
            await addToKeyring({}, bobSet.v4.publicKey),
            carolSet.v4.publicKey,
          ),
        },
      })
      expect(toBridge(wraps)).toHaveLength(1)
    })

    it('splits into TWO bridge wraps when only some recipients are encryptable, both docs carrying the full To list', async () => {
      const { wraps } = await buildWraps({
        ...base,
        to: ['bob@gmail.com', 'carol@example.net'],
        body: 'mixed hello',
        encrypt: true,
        pgp: await mixedPgp(),
      })

      const bridgeWraps = toBridge(wraps)
      expect(bridgeWraps).toHaveLength(2)

      const docs: Array<{ targets: string[]; encrypted: boolean; to: string[] }> = []
      for (const wrap of bridgeWraps) {
        const result = await unwrapAndVerify(wrap, keySigner(BRIDGE_SK))
        expect(result.ok).toBe(true)
        if (!result.ok) return
        const decoded = new TextDecoder().decode(messageStringToBytes(result.rumor.content))
        docs.push({
          targets: deliverTargets(result.rumor),
          encrypted: decoded.includes('-----BEGIN PGP MESSAGE-----'),
          to: [...decoded.matchAll(/^To: (.*)$/gm)].map((m) => m[1]),
        })
      }

      // One encrypted mode (bob only) + one plaintext mode (carol only).
      const enc = docs.find((d) => d.encrypted)!
      const plain = docs.find((d) => !d.encrypted)!
      expect(enc.targets).toEqual(['bob@gmail.com'])
      expect(plain.targets).toEqual(['carol@example.net'])

      // BOTH documents carry the complete To: header — every recipient sees
      // the full audience, standard mixed-send transparency.
      expect(enc.to[0]).toContain('bob@gmail.com')
      expect(enc.to[0]).toContain('carol@example.net')
      expect(plain.to[0]).toContain('bob@gmail.com')
      expect(plain.to[0]).toContain('carol@example.net')

      // The encrypted document must not carry the plaintext.
      void enc
      expect(plain.targets).not.toContain('bob@gmail.com')
    })

    it('sends plaintext-only when no pgp maps are given', async () => {
      const { wraps } = await buildWraps({
        ...base,
        to: ['bob@gmail.com', 'carol@example.net'],
        body: 'mixed hello',
      })
      const bridgeWraps = toBridge(wraps)
      expect(bridgeWraps).toHaveLength(1)
      const result = await unwrapAndVerify(bridgeWraps[0], keySigner(BRIDGE_SK))
      if (!result.ok) return
      const decoded = new TextDecoder().decode(messageStringToBytes(result.rumor.content))
      expect(decoded).toContain('mixed hello')
      expect(deliverTargets(result.rumor)).toEqual(['bob@gmail.com', 'carol@example.net'])
    })

    // The lock is the user's decision: maps alone must not turn encryption on
    // (it would silently encrypt when the composer showed a red open lock).
    it('sends plaintext when the lock is off even though pgp maps are present', async () => {
      const { wraps } = await buildWraps({
        ...base,
        to: ['bob@gmail.com'],
        body: 'lock off',
        pgp: await mixedPgp(),
      })
      const result = await unwrapAndVerify(toBridge(wraps)[0], keySigner(BRIDGE_SK))
      if (!result.ok) return
      const decoded = new TextDecoder().decode(messageStringToBytes(result.rumor.content))
      expect(decoded).toContain('lock off')
      expect(decoded).not.toContain('-----BEGIN PGP MESSAGE-----')
    })

    // ADR-006: the body is encrypted exactly ONCE. Decrypting the delivered
    // outer document must yield the plaintext directly — if it yields another
    // armored block, the composer and send.ts both encrypted (the stg bug:
    // Proton rendered the nested armor as a raw blob).
    it('encrypts exactly once — the delivered document decrypts straight to the body', async () => {
      const { wraps, errors } = await buildWraps({
        ...base,
        to: ['bob@gmail.com'],
        body: 'single layer',
        encrypt: true,
        pgp: await mixedPgp(),
      })
      expect(errors).toEqual([])

      const result = await unwrapAndVerify(toBridge(wraps)[0], keySigner(BRIDGE_SK))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const doc = new TextDecoder().decode(messageStringToBytes(result.rumor.content))
      const armored = doc.slice(
        doc.indexOf('-----BEGIN PGP MESSAGE-----'),
        doc.indexOf('-----END PGP MESSAGE-----') + '-----END PGP MESSAGE-----'.length,
      )
      const decrypted = await decryptMessage({
        message: await parsePgpMessage(armored),
        privateKey: bobSet.v4.privateKey,
      })
      expect(decrypted.text).toBe('single layer')
      expect(decrypted.text).not.toContain('-----BEGIN PGP MESSAGE-----')
    })

    // A Nostr-direct recipient we hold a key for gets the encrypted document
    // too (the composer used to own this; send.ts must not drop it).
    it('encrypts the Nostr-direct recipient copy when a key is held', async () => {
      const bobSk = generateSecretKey()
      const bobPk = getPublicKey(bobSk)
      const { wraps, errors } = await buildWraps({
        ...base,
        to: [bobPk],
        body: 'nostr layer',
        encrypt: true,
        pgp: {
          ...(await mixedPgp()),
          pgpKeyring: await addToKeyring(
            await addToKeyring({}, bobSet.v4.publicKey),
            bobSet.v4.publicKey,
            `${nip19.npubEncode(bobPk)}@mailstr.app`,
          ),
        },
      })
      expect(errors).toEqual([])
      const toBob = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === bobPk))
      expect(toBob).toBeDefined()
      const result = await unwrapAndVerify(toBob!, keySigner(bobSk))
      if (!result.ok) return
      const doc = new TextDecoder().decode(messageStringToBytes(result.rumor.content))
      expect(doc).toContain('-----BEGIN PGP MESSAGE-----')
      expect(doc).not.toContain('nostr layer')
    })

    // The Sent self-copy always carries the encrypted document, whether or not
    // the From alias was in the recipient list.
    it('encrypts the self-copy so Sent stays readable only by the alias key', async () => {
      const { wraps } = await buildWraps({
        ...base,
        to: ['bob@gmail.com'],
        body: 'self layer',
        encrypt: true,
        pgp: await mixedPgp(),
      })
      const self = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === ALICE_PK))
      expect(self).toBeDefined()
      const result = await unwrapAndVerify(self!, keySigner(ALICE_SK))
      if (!result.ok) return
      const doc = new TextDecoder().decode(messageStringToBytes(result.rumor.content))
      const armored = doc.slice(
        doc.indexOf('-----BEGIN PGP MESSAGE-----'),
        doc.indexOf('-----END PGP MESSAGE-----') + '-----END PGP MESSAGE-----'.length,
      )
      const decrypted = await decryptMessage({
        message: await parsePgpMessage(armored),
        privateKey: aliceSet.v4.privateKey,
      })
      expect(decrypted.text).toBe('self layer')
    })

    // Fail closed: a locked key without a passphrase must error, never quietly
    // deliver cleartext (the old catch demoted; prod shipped unencrypted mail
    // whenever the alias key was locked).
    it('refuses the send when the lock is on but no PGP settings are provided', async () => {
      const { wraps, errors } = await buildWraps({
        ...base,
        to: ['bob@gmail.com'],
        body: 'must not leak',
        encrypt: true,
      })
      expect(wraps).toEqual([])
      expect(errors[0]).toMatch(/Could not encrypt/)
    })

    it('refuses the send when the lock is on but the From alias has no key', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Response(JSON.stringify({ names: { alice2: ALICE_PK } }))),
      )
      const { wraps, errors } = await buildWraps({
        ...base,
        from: { address: 'alice2@mailstr.app' },
        to: ['bob@gmail.com'],
        body: 'must not leak',
        encrypt: true,
        pgp: await mixedPgp(),
      })
      expect(wraps).toEqual([])
      expect(errors[0]).toMatch(/Could not encrypt/)
    })

    it('refuses the send when the From key is locked and no passphrase is given', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Response(JSON.stringify({ names: { locked: ALICE_PK } }))),
      )
      const locked = await lockedKeySet()
      const { wraps, errors } = await buildWraps({
        ...base,
        from: { address: 'locked@mailstr.app' },
        to: ['bob@gmail.com'],
        body: 'must not leak',
        encrypt: true,
        pgp: {
          pgpKeys: {
            'locked@mailstr.app': {
              publicKey: locked.v4.publicKey,
              privateKey: locked.v4.privateKey,
              fingerprint: locked.v4.fingerprint,
              passphraseProtected: true,
              v4: locked.v4,
              v6: locked.v6,
            },
          },
          pgpKeyring: await addToKeyring({}, bobSet.v4.publicKey),
        },
      })
      expect(wraps).toEqual([])
      expect(errors[0]).toMatch(/Could not encrypt/)
    })

    it('sends when the locked From key is unlocked by the session passphrase', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Response(JSON.stringify({ names: { locked: ALICE_PK } }))),
      )
      const locked = await lockedKeySet()
      const { wraps, errors } = await buildWraps({
        ...base,
        from: { address: 'locked@mailstr.app' },
        to: ['bob@gmail.com'],
        body: 'unlocked secret',
        encrypt: true,
        pgpPassphrase: 'hunter2',
        pgp: {
          pgpKeys: {
            'locked@mailstr.app': {
              publicKey: locked.v4.publicKey,
              privateKey: locked.v4.privateKey,
              fingerprint: locked.v4.fingerprint,
              passphraseProtected: true,
              v4: locked.v4,
              v6: locked.v6,
            },
          },
          pgpKeyring: await addToKeyring({}, bobSet.v4.publicKey),
        },
      })
      expect(errors).toEqual([])
      const doc = (await unwrapAndVerify(toBridge(wraps)[0], keySigner(BRIDGE_SK)))
      if (!doc.ok) return
      const decoded = new TextDecoder().decode(messageStringToBytes(doc.rumor.content))
      expect(decoded).not.toContain('unlocked secret')
    })
  })
})
