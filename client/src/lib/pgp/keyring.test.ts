import { describe, it, expect, beforeAll } from 'vitest'
import { generateKey, type GeneratedKey } from './openpgp'
import {
  keyringKey,
  keyForAddress,
  haveKeysForAll,
  addressesMissingKeys,
  addToKeyring,
  removeFromKeyring,
  keyringEntries,
} from './keyring'

let alice: GeneratedKey // the user
let bob: GeneratedKey // a correspondent

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([
    generateKey({ name: 'Alice', email: 'alice@mailstr.app' }),
    generateKey({ name: 'Bob', email: 'Bob@Gmail.com' }), // mixed case on purpose
  ])
}, 30_000)

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

  it('resolves the user’s own address to their own public key without a keyring entry', () => {
    const settings = {
      pgpPublicKey: alice.publicKey,
      pgpKeyring: {},
      ownAddresses: ['alice@mailstr.app'],
    }
    expect(keyForAddress(settings, 'alice@mailstr.app')).toBe(alice.publicKey)
  })

  it('haveKeysForAll is true only when every recipient has a key', async () => {
    const ring = await addToKeyring({}, bob.publicKey)
    const settings = { pgpKeyring: ring, pgpPublicKey: alice.publicKey, ownAddresses: ['alice@mailstr.app'] }
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

describe('keyringEntries', () => {
  it('decodes entries for display and skips unreadable ones', async () => {
    const ring = { ...(await addToKeyring({}, bob.publicKey)), 'broken@x.com': 'not a key' }
    const entries = await keyringEntries(ring)
    expect(entries.find((e) => e.address === 'bob@gmail.com')?.fingerprint).toBe(bob.fingerprint)
    expect(entries.find((e) => e.address === 'broken@x.com')).toBeUndefined()
  })
})
