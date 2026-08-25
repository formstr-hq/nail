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
  /** Settings with `me@mailstr.app` as an own alias key and Bob in the keyring. */
  async function settingsWithMeAndBob() {
    return {
      pgpKeyring: await addToKeyring({}, bob.publicKey),
      pgpKeys: {
        'me@mailstr.app': {
          publicKey: me.publicKey,
          privateKey: me.privateKey,
          fingerprint: me.fingerprint,
        },
      },
    }
  }

  it('signs with the From alias key, encrypts to recipient + self, both decrypt', async () => {
    const armored = await encryptBody({
      body: 'top secret',
      fromAddress: 'me@mailstr.app',
      recipients: ['bob@gmail.com'],
      settings: await settingsWithMeAndBob(),
    })
    expect(isPgpMessage(armored)).toBe(true)
    expect(armored).not.toContain('top secret')

    // Recipient reads it, and verifies the From alias's signature.
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
        fromAddress: 'me@mailstr.app',
        recipients: ['stranger@nowhere.com'],
        settings: await settingsWithMeAndBob(),
      }),
    ).rejects.toThrow(/No PGP key for stranger@nowhere.com/)
  })

  it('refuses when the From alias has no key', async () => {
    await expect(
      encryptBody({
        body: 'x',
        fromAddress: 'other@mailstr.app', // no key for this alias
        recipients: ['bob@gmail.com'],
        settings: await settingsWithMeAndBob(),
      }),
    ).rejects.toThrow(/No PGP key for other@mailstr.app/)
  })
})
