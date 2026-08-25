import { describe, it, expect, beforeAll } from 'vitest'
import { generateKey, decryptMessage, isPgpMessage, type GeneratedKey } from './openpgp'
import { addToKeyring } from './keyring'
import { cleartextRecipients, encryptBody } from './compose'

let me: GeneratedKey
let bob: GeneratedKey

beforeAll(async () => {
  ;[me, bob] = await Promise.all([
    generateKey({ name: 'Me', email: 'me@mailstr.app' }),
    generateKey({ name: 'Bob', email: 'bob@gmail.com' }),
  ])
}, 30_000)

describe('cleartextRecipients', () => {
  it('flags known plaintext providers, case-insensitively', () => {
    expect(cleartextRecipients(['bob@Gmail.com', 'x@outlook.com', 'a@mailstr.app'])).toEqual([
      'bob@Gmail.com',
      'x@outlook.com',
    ])
  })

  it('does not flag addresses we can’t parse a domain from', () => {
    expect(cleartextRecipients(['npub1abc', 'plainstring'])).toEqual([])
  })
})

describe('encryptBody', () => {
  it('encrypts to the recipient AND the sender, signs, and both can decrypt', async () => {
    const keyring = await addToKeyring({}, bob.publicKey)
    const settings = {
      pgpKeyring: keyring,
      pgpPublicKey: me.publicKey,
      pgpPrivateKey: me.privateKey,
    }

    const armored = await encryptBody({
      body: 'top secret',
      recipients: ['bob@gmail.com'],
      settings,
      ownAddresses: ['me@mailstr.app'],
    })
    expect(isPgpMessage(armored)).toBe(true)
    expect(armored).not.toContain('top secret')

    // Recipient reads it, and verifies the sender's signature.
    const asBob = await decryptMessage({
      armored,
      privateKey: bob.privateKey,
      verificationPublicKeys: [me.publicKey],
    })
    expect(asBob.text).toBe('top secret')
    expect(asBob.signature.status).toBe('valid')

    // Sender's own Sent copy stays readable — the whole reason we encrypt to self.
    const asMe = await decryptMessage({ armored, privateKey: me.privateKey })
    expect(asMe.text).toBe('top secret')
  })

  it('refuses when a recipient has no key', async () => {
    await expect(
      encryptBody({
        body: 'x',
        recipients: ['stranger@nowhere.com'],
        settings: { pgpKeyring: {}, pgpPublicKey: me.publicKey, pgpPrivateKey: me.privateKey },
      }),
    ).rejects.toThrow(/No PGP key for stranger@nowhere.com/)
  })

  it('refuses when the sender has no PGP key at all', async () => {
    await expect(
      encryptBody({ body: 'x', recipients: ['bob@gmail.com'], settings: {} }),
    ).rejects.toThrow(/no PGP key/i)
  })
})
