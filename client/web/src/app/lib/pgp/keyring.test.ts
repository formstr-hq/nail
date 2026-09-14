import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeySet, type GeneratedKey } from './openpgp'
import {
  keyringKey,
  keyForAddress,
  allKeysForAddress,
  haveKeysForAll,
  addressesMissingKeys,
  addToKeyring,
  removeFromKeyring,
  keyringEntries,
  keysInEntry,
  ownKeypairFor,
  allOwnKeypairs,
  hasAnyOwnKey,
  ownPublicKeysFor,
  ownPrivateKeysFor,
} from './keyring'

let alice: GeneratedKey // the user
let bob: GeneratedKey // a correspondent
let aliceSet: Awaited<ReturnType<typeof generateKeySet>> // the dual set

beforeAll(async () => {
  ;[alice, bob, aliceSet] = await Promise.all([
    generateKeySet({ email: 'alice@mailstr.app' }).then((s) => s.v4),
    generateKeySet({ email: 'Bob@Gmail.com' }).then((s) => s.v4), // mixed case on purpose
    generateKeySet({ email: 'dual@mailstr.app' }),
  ])
}, 60_000)

describe('keyringKey', () => {
  it('lowercases and trims, matching the app’s address comparison', () => {
    expect(keyringKey('  Bob@Gmail.COM ')).toBe('bob@gmail.com')
  })
})

describe('addToKeyring', () => {
  it('files a key under every address it claims, normalized', async () => {
    const ring = await addToKeyring({}, bob.publicKey)
    expect(ring['bob@gmail.com']).toBe(bob.publicKey)
  })

  it('also files under an explicit address when the user names one', async () => {
    const ring = await addToKeyring({}, bob.publicKey, 'bob.alias@work.com')
    expect(ring['bob@gmail.com']).toBeDefined()
    expect(ring['bob.alias@work.com']).toBe(bob.publicKey)
  })

  it('rejects input that is not a public key', async () => {
    await expect(addToKeyring({}, 'garbage')).rejects.toThrow()
  })
})

describe('lookup + gating', () => {
  it('finds a correspondent key regardless of address case', async () => {
    const ring = await addToKeyring({}, bob.publicKey)
    expect(keyForAddress({ pgpKeyring: ring }, 'BOB@gmail.com')).toBe(bob.publicKey)
  })

  it('resolves the user’s own alias to that alias’s public key without a keyring entry', () => {
    const settings = {
      pgpKeyring: {},
      pgpKeys: {
        'alice@mailstr.app': {
          publicKey: alice.publicKey,
          privateKey: alice.privateKey,
          fingerprint: alice.fingerprint,
        },
      },
    }
    expect(keyForAddress(settings, 'ALICE@mailstr.app')).toBe(alice.publicKey)
  })

  it('haveKeysForAll is true only when every recipient has a key', async () => {
    const ring = await addToKeyring({}, bob.publicKey)
    const settings = {
      pgpKeyring: ring,
      pgpKeys: {
        'alice@mailstr.app': {
          publicKey: alice.publicKey,
          privateKey: alice.privateKey,
          fingerprint: alice.fingerprint,
        },
      },
    }
    expect(haveKeysForAll(settings, ['bob@gmail.com', 'alice@mailstr.app'])).toBe(true)
    expect(haveKeysForAll(settings, ['bob@gmail.com', 'carol@nowhere.com'])).toBe(false)
    expect(haveKeysForAll(settings, [])).toBe(false)
  })

  it('addressesMissingKeys names exactly the gaps', async () => {
    const ring = await addToKeyring({}, bob.publicKey)
    expect(addressesMissingKeys({ pgpKeyring: ring }, ['bob@gmail.com', 'carol@x.com'])).toEqual([
      'carol@x.com',
    ])
  })
})

describe('removeFromKeyring', () => {
  it('drops the entry', async () => {
    const ring = await addToKeyring({}, bob.publicKey)
    const after = removeFromKeyring(ring, 'BOB@gmail.com')
    expect(after['bob@gmail.com']).toBeUndefined()
  })
})

describe('own per-alias keys', () => {
  const settings = {
    pgpKeys: {
      'alice@mailstr.app': {
        publicKey: 'PUB_A',
        privateKey: 'PRIV_A',
        fingerprint: 'fpA',
      },
      'alias2@mailstr.app': {
        publicKey: 'PUB_2',
        privateKey: 'PRIV_2',
        fingerprint: 'fp2',
      },
    },
  }

  it('ownKeypairFor resolves a normalized alias to its own keypair', () => {
    expect(ownKeypairFor(settings, 'ALICE@mailstr.app')?.fingerprint).toBe('fpA')
    expect(ownKeypairFor(settings, 'nokey@mailstr.app')).toBeUndefined()
  })

  it('allOwnKeypairs returns every alias key; hasAnyOwnKey reflects presence', () => {
    expect(allOwnKeypairs(settings)).toHaveLength(2)
    expect(hasAnyOwnKey(settings)).toBe(true)
    expect(hasAnyOwnKey({})).toBe(false)
    expect(allOwnKeypairs({})).toEqual([])
  })

  it('keys are distinct per alias — no key links one alias to another', () => {
    // Each alias resolves ONLY to its own public key; there is no shared key.
    expect(keyForAddress(settings, 'alice@mailstr.app')).toBe('PUB_A')
    expect(keyForAddress(settings, 'alias2@mailstr.app')).toBe('PUB_2')
  })
})

describe('keyringEntries', () => {
  it('decodes entries for display and skips unreadable ones', async () => {
    const ring = { ...(await addToKeyring({}, bob.publicKey)), 'broken@x.com': 'not a key' }
    const entries = await keyringEntries(ring)
    expect(entries.find((e) => e.address === 'bob@gmail.com')?.fingerprint).toBe(bob.fingerprint)
    expect(entries.find((e) => e.address === 'broken@x.com')).toBeUndefined()
  })

  it('reports a count of 2 for a dual multi-key entry', async () => {
    const ring = await addToKeyring({}, [aliceSet.v4.publicKey, aliceSet.v6.publicKey], 'dual@x.com')
    const entries = await keyringEntries(ring)
    expect(entries.find((e) => e.address === 'dual@x.com')?.count).toBe(2)
  })
})

describe('dual (v4 + v6) key sets', () => {
  it('generateKeySet yields two distinct keys bound to the same email', () => {
    expect(aliceSet.v4.fingerprint).not.toBe(aliceSet.v6.fingerprint)
    expect(aliceSet.v4.publicKey).not.toBe(aliceSet.v6.publicKey)
  })

  it('ownPublicKeysFor surfaces BOTH halves for encryption', () => {
    const keypair = {
      publicKey: aliceSet.v4.publicKey,
      privateKey: aliceSet.v4.privateKey,
      fingerprint: aliceSet.v4.fingerprint,
      v4: aliceSet.v4,
      v6: aliceSet.v6,
    }
    const pubs = ownPublicKeysFor(keypair)
    expect(pubs).toEqual([aliceSet.v4.publicKey, aliceSet.v6.publicKey])
    // And the private halves decrypt with either.
    expect(ownPrivateKeysFor(keypair)).toHaveLength(2)
  })

  it('a passphrase-protected keypair stamps the lock flag onto every half', () => {
    // `passphraseProtected` lives on the keypair, not on the KeyHalves —
    // dropping it here made passphrase-protected dual sets look unlocked, so
    // the viewer fed an encrypted private key to openpgp and decryption
    // always failed without ever prompting for the passphrase.
    const lockedPair = {
      publicKey: aliceSet.v4.publicKey,
      privateKey: aliceSet.v4.privateKey,
      fingerprint: aliceSet.v4.fingerprint,
      passphraseProtected: true,
      v4: { ...aliceSet.v4 },
      v6: { ...aliceSet.v6 },
    }
    expect(ownPrivateKeysFor(lockedPair)).toEqual([
      { ...aliceSet.v4, passphraseProtected: true, keypairFingerprint: lockedPair.fingerprint },
      { ...aliceSet.v6, passphraseProtected: true, keypairFingerprint: lockedPair.fingerprint },
    ])
    // Unlocked sets stay flagged false-y.
    expect(ownPrivateKeysFor({ ...lockedPair, passphraseProtected: false })).toEqual([
      { ...aliceSet.v4, passphraseProtected: false, keypairFingerprint: lockedPair.fingerprint },
      { ...aliceSet.v6, passphraseProtected: false, keypairFingerprint: lockedPair.fingerprint },
    ])
  })

  // Regression: the passphrase cache (session.ts) is keyed by fingerprint, but
  // a dual set's two halves have DIFFERENT fingerprints even though one
  // passphrase unlocks both. Stamping each half with its own fingerprint made
  // unlocking one half never unlock the other — the reader kept getting
  // re-prompted for a key they'd already unlocked. Both halves must report the
  // SAME (keypair-level) fingerprint for the passphrase cache to key off.
  it('stamps every half with the KEYPAIR fingerprint, not the half\'s own, for passphrase caching', () => {
    const lockedPair = {
      publicKey: aliceSet.v4.publicKey,
      privateKey: aliceSet.v4.privateKey,
      fingerprint: aliceSet.v4.fingerprint,
      passphraseProtected: true,
      v4: { ...aliceSet.v4 },
      v6: { ...aliceSet.v6 },
    }
    const [v4Half, v6Half] = ownPrivateKeysFor(lockedPair)
    expect(v4Half.keypairFingerprint).toBe(lockedPair.fingerprint)
    expect(v6Half.keypairFingerprint).toBe(lockedPair.fingerprint)
    expect(v4Half.keypairFingerprint).toBe(v6Half.keypairFingerprint)
  })

  it('a legacy single-pair entry still works through the dual helpers', () => {
    const legacy = {
      publicKey: 'PUB_A',
      privateKey: 'PRIV_A',
      fingerprint: 'fpA',
    }
    expect(ownPublicKeysFor(legacy)).toEqual(['PUB_A'])
    expect(ownPrivateKeysFor(legacy)).toHaveLength(1)
    expect(ownPrivateKeysFor(legacy)[0].keypairFingerprint).toBe('fpA')
  })

  it('keysInEntry splits a multi-key ring entry back out', async () => {
    const ring = await addToKeyring({}, [aliceSet.v4.publicKey, aliceSet.v6.publicKey], 'multi@x.com')
    const entry = ring['multi@x.com']
    const keys = keysInEntry(entry)
    expect(keys).toHaveLength(2)
    // Blocks are canonicalized (trailing newline trimmed) by the store, so
    // compare modulo that.
    expect(keys.map((k) => k.trimEnd())).toContain(aliceSet.v4.publicKey.trimEnd())
    expect(keys.map((k) => k.trimEnd())).toContain(aliceSet.v6.publicKey.trimEnd())
  })

  it('allKeysForAddress hands every embedded ring key to the encrypt path', async () => {
    const ring = await addToKeyring({}, [bob.publicKey], 'bob@gmail.com')
    const settings = {
      pgpKeyring: ring,
      pgpKeys: {
        'me@mailstr.app': {
          publicKey: aliceSet.v4.publicKey,
          privateKey: aliceSet.v4.privateKey,
          fingerprint: aliceSet.v4.fingerprint,
          v4: { ...aliceSet.v4 },
          v6: { ...aliceSet.v6 },
        },
      },
    }
    // Recipient (1 key) + own dual (2 keys) = 3 distinct keys to encrypt to.
    expect(allKeysForAddress(settings, 'bob@gmail.com')).toEqual([bob.publicKey])
    expect(allKeysForAddress(settings, 'me@mailstr.app')).toHaveLength(2)
  })
})
