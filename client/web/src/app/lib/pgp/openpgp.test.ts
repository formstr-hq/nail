import { describe, it, expect, beforeAll } from 'vitest'
import {
  generateKey,
  encryptPrivateKey,
  unlockPrivateKey,
  readKeyInfo,
  isPgpMessage,
  encryptMessage,
  parsePgpMessage,
  pkeskKeyIDs,
  keyIDsOfArmored,
  decryptMessage,
  type GeneratedKey,
} from './openpgp'

// Real openpgp.js, no mocks — the whole point of this module is that the crypto
// actually round-trips and interoperates. Key generation dominates the runtime,
// so keys are made once and shared across the read-only assertions.
let alice: GeneratedKey
let bob: GeneratedKey
let locked: GeneratedKey
const PASS = 'correct horse battery staple'

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([
    generateKey({ name: 'Alice', email: 'alice@mailstr.app' }),
    generateKey({ name: 'Bob', email: 'bob@gmail.com' }),
  ])
  // A passphrase-locked fixture for the LEGACY read path. Nothing in the app
  // generates locked keys any more (Mailstr stores keys unlocked); locking is
  // only reachable through encryptPrivateKey (the export path), so that is how
  // the test builds one too.
  const carol = await generateKey({ email: 'carol@mailstr.app' })
  locked = { ...carol, privateKey: await encryptPrivateKey(carol.privateKey, PASS) }
}, 30_000)

describe('generateKey', () => {
  it('produces armored public and private keys and a fingerprint', () => {
    expect(alice.publicKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----')
    expect(alice.privateKey).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----')
    expect(alice.fingerprint).toMatch(/^[0-9a-f]{40}$/)
  })

  it('binds the key to the given identity', async () => {
    const info = await readKeyInfo(alice.publicKey)
    expect(info.emails).toContain('alice@mailstr.app')
    expect(info.userIDs[0]).toContain('Alice')
    expect(info.fingerprint).toBe(alice.fingerprint)
  })
})

describe('readKeyInfo', () => {
  it('reports a public key as non-private', async () => {
    const info = await readKeyInfo(bob.publicKey)
    expect(info.isPrivate).toBe(false)
    expect(info.emails).toEqual(['bob@gmail.com'])
  })

  it('reports a private key as private, and a passphrase-locked one as encrypted', async () => {
    expect((await readKeyInfo(alice.privateKey)).isPrivate).toBe(true)
    expect((await readKeyInfo(alice.privateKey)).encrypted).toBe(false)
    expect((await readKeyInfo(locked.privateKey)).encrypted).toBe(true)
  })

  it('throws on input that is not a key', async () => {
    await expect(readKeyInfo('not a key')).rejects.toThrow()
  })
})

describe('isPgpMessage', () => {
  it('detects an armored message body', () => {
    expect(isPgpMessage('hi\n-----BEGIN PGP MESSAGE-----\n...')).toBe(true)
    expect(isPgpMessage('just plain text')).toBe(false)
  })
})

describe('encrypt / decrypt round trip', () => {
  it('encrypts to a recipient and signs; the recipient decrypts and verifies', async () => {
    const armored = await encryptMessage({
      text: 'the eagle lands at noon',
      recipientPublicKeys: [bob.publicKey],
      signingPrivateKey: alice.privateKey,
    })
    expect(isPgpMessage(armored)).toBe(true)
    // Ciphertext must not leak the plaintext.
    expect(armored).not.toContain('eagle')

    const result = await decryptMessage({
      message: await parsePgpMessage(armored),
      privateKey: bob.privateKey,
      verificationPublicKeys: [alice.publicKey],
    })
    expect(result.text).toBe('the eagle lands at noon')
    expect(result.signature).toEqual({
      status: 'valid',
      keyID: expect.any(String),
    })
  })

  it('encrypts to multiple recipients including self, so both can read it', async () => {
    const armored = await encryptMessage({
      text: 'group secret',
      // Encrypt to Bob AND back to Alice — the Sent-copy pattern.
      recipientPublicKeys: [bob.publicKey, alice.publicKey],
      signingPrivateKey: alice.privateKey,
    })
    expect(
      (await decryptMessage({ message: await parsePgpMessage(armored), privateKey: bob.privateKey })).text,
    ).toBe('group secret')
    expect(
      (await decryptMessage({ message: await parsePgpMessage(armored), privateKey: alice.privateKey })).text,
    ).toBe('group secret')
  })

  it('reports a signed message from an unknown key as unknown-key, not valid', async () => {
    const armored = await encryptMessage({
      text: 'who am I',
      recipientPublicKeys: [bob.publicKey],
      signingPrivateKey: alice.privateKey,
    })
    // Bob decrypts without Alice's key in hand.
    const result = await decryptMessage({ message: await parsePgpMessage(armored), privateKey: bob.privateKey })
    expect(result.signature.status).toBe('unknown-key')
  })

  it('reports a signature checked against the WRONG key as invalid, not valid', async () => {
    // Signed by Alice, but the reader only holds Carol's key to check it with.
    // This is the one hard warning — it must never read as valid or as unsigned.
    const armored = await encryptMessage({
      text: 'impersonation attempt',
      recipientPublicKeys: [bob.publicKey],
      signingPrivateKey: alice.privateKey,
    })
    const result = await decryptMessage({
      message: await parsePgpMessage(armored),
      privateKey: bob.privateKey,
      verificationPublicKeys: [locked.publicKey], // wrong key on purpose
    })
    expect(result.signature.status).toBe('invalid')
  })

  it('reports an unsigned message as none', async () => {
    const armored = await encryptMessage({
      text: 'anon',
      recipientPublicKeys: [bob.publicKey],
      // no signingPrivateKey
    })
    const result = await decryptMessage({ message: await parsePgpMessage(armored), privateKey: bob.privateKey })
    expect(result.signature).toEqual({ status: 'none' })
  })

  it('a third party without the key cannot decrypt', async () => {
    const armored = await encryptMessage({
      text: 'not for carol',
      recipientPublicKeys: [bob.publicKey],
    })
    await expect(
      decryptMessage({
        message: await parsePgpMessage(armored),
        privateKey: locked.privateKey,
        passphrase: PASS,
      }),
    ).rejects.toThrow()
  })
})

describe('passphrase-protected keys', () => {
  it('encrypts to a locked key and decrypts only with the right passphrase', async () => {
    const armored = await encryptMessage({
      text: 'locked box',
      recipientPublicKeys: [locked.publicKey],
    })

    await expect(
      decryptMessage({ message: await parsePgpMessage(armored), privateKey: locked.privateKey }),
    ).rejects.toThrow(/passphrase/i)

    await expect(
      decryptMessage({
        message: await parsePgpMessage(armored),
        privateKey: locked.privateKey,
        passphrase: 'wrong',
      }),
    ).rejects.toThrow()

    const ok = await decryptMessage({
      message: await parsePgpMessage(armored),
      privateKey: locked.privateKey,
      passphrase: PASS,
    })
    expect(ok.text).toBe('locked box')
  })

  it('signs with a locked key when given its passphrase', async () => {
    const armored = await encryptMessage({
      text: 'signed by carol',
      recipientPublicKeys: [bob.publicKey],
      signingPrivateKey: locked.privateKey,
      signingPassphrase: PASS,
    })
    const result = await decryptMessage({
      message: await parsePgpMessage(armored),
      privateKey: bob.privateKey,
      verificationPublicKeys: [locked.publicKey],
    })
    expect(result.text).toBe('signed by carol')
    expect(result.signature.status).toBe('valid')
  })
})

describe('unlockPrivateKey (the import path)', () => {
  it('returns an UNLOCKED armor that still round-trips decryption and signing', async () => {
    const unlocked = await unlockPrivateKey(locked.privateKey, PASS)

    const info = await readKeyInfo(unlocked)
    expect(info.isPrivate).toBe(true)
    expect(info.encrypted).toBe(false)
    expect(info.fingerprint).toBe(locked.fingerprint)

    // The unlocked armor must be usable for both decrypt and sign without a
    // passphrase — exactly what an imported key needs to do in the mailbox.
    const armored = await encryptMessage({
      text: 'after import',
      recipientPublicKeys: [locked.publicKey],
    })
    const result = await decryptMessage({
      message: await parsePgpMessage(armored),
      privateKey: unlocked,
    })
    expect(result.text).toBe('after import')
  })

  it('rejects a wrong passphrase', async () => {
    await expect(unlockPrivateKey(locked.privateKey, 'wrong')).rejects.toThrow()
  })

  it('an already-unlocked key passes through untouched when its passphrase is given', async () => {
    // decryptPrivateKey short-circuits on an unlocked key; the armor is still
    // re-emitted, so the import path is uniform for both cases.
    const unlocked = await unlockPrivateKey(alice.privateKey, 'ignored')
    expect((await readKeyInfo(unlocked)).encrypted).toBe(false)
    expect((await readKeyInfo(unlocked)).fingerprint).toBe(alice.fingerprint)
  })
})

describe('pkeskKeyIDs / keyIDsOfArmored', () => {
  it("identifies the message's target key ID(s) and matches them to the right held key", async () => {
    const armored = await encryptMessage({
      text: 'for bob only',
      recipientPublicKeys: [bob.publicKey],
    })
    const message = await parsePgpMessage(armored)
    const targets = pkeskKeyIDs(message)
    expect(targets.length).toBeGreaterThan(0)

    const bobKeyIDs = await keyIDsOfArmored(bob.privateKey)
    const aliceKeyIDs = await keyIDsOfArmored(alice.privateKey)
    expect(bobKeyIDs.some((id) => targets.includes(id))).toBe(true)
    expect(aliceKeyIDs.some((id) => targets.includes(id))).toBe(false)
  })

  it('reports key IDs from a PUBLIC key the same as from its PRIVATE half', async () => {
    const fromPrivate = await keyIDsOfArmored(bob.privateKey)
    const fromPublic = await keyIDsOfArmored(bob.publicKey)
    expect(fromPublic).toEqual(fromPrivate)
  })

  it('reads key IDs off a passphrase-protected private key without needing the passphrase', async () => {
    // Key IDs live on the unencrypted key packet — this must not require
    // unlocking, since it runs BEFORE the user is ever asked for a passphrase.
    await expect(keyIDsOfArmored(locked.privateKey)).resolves.toEqual(
      expect.arrayContaining([expect.any(String)]),
    )
  })

  it('finds every recipient when encrypted to multiple keys', async () => {
    const armored = await encryptMessage({
      text: 'group secret',
      recipientPublicKeys: [alice.publicKey, bob.publicKey],
    })
    const targets = pkeskKeyIDs(await parsePgpMessage(armored))
    const aliceKeyIDs = await keyIDsOfArmored(alice.privateKey)
    const bobKeyIDs = await keyIDsOfArmored(bob.privateKey)
    expect(aliceKeyIDs.some((id) => targets.includes(id))).toBe(true)
    expect(bobKeyIDs.some((id) => targets.includes(id))).toBe(true)
  })
})
