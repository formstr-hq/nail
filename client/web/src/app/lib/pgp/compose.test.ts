import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeySet, parsePgpMessage, decryptMessage, isPgpMessage } from './openpgp'
import { addToKeyring } from './keyring'
import { encryptBody } from './compose'
import type { GeneratedKey } from './openpgp'

let me: GeneratedKey
let bob: GeneratedKey
let mySet: Awaited<ReturnType<typeof generateKeySet>>

beforeAll(async () => {
  ;[mySet, bob] = await Promise.all([
    generateKeySet({ email: 'me@mailstr.app' }),
    generateKeySet({ email: 'bob@gmail.com' }).then((s) => s.v4),
  ])
  me = mySet.v4
}, 60_000)

describe('encryptBody', () => {
  /** Settings with `me@mailstr.app` as an own DUAL alias key and Bob in the keyring. */
  async function settingsWithMeAndBob() {
    return {
      pgpKeyring: await addToKeyring({}, bob.publicKey),
      pgpKeys: {
        'me@mailstr.app': {
          publicKey: mySet.v4.publicKey,
          privateKey: mySet.v4.privateKey,
          fingerprint: mySet.v4.fingerprint,
          v4: mySet.v4,
          v6: mySet.v6,
        },
      },
    }
  }

  it('signs with the From alias key, encrypts to recipient + both own halves, all decrypt', async () => {
    const armored = await encryptBody({
      body: 'top secret',
      fromAddress: 'me@mailstr.app',
      recipients: ['bob@gmail.com'],
      settings: await settingsWithMeAndBob(),
    })
    expect(isPgpMessage(armored)).toBe(true)
    expect(armored).not.toContain('top secret')

    // Recipient reads it, and verifies the From alias's v4 signature.
    const asBob = await decryptMessage({
      message: await parsePgpMessage(armored),
      privateKey: bob.privateKey,
      verificationPublicKeys: [me.publicKey],
    })
    expect(asBob.text).toBe('top secret')
    expect(asBob.signature.status).toBe('valid')

    // Sender's own Sent copy stays readable by EITHER dual half — the whole
    // reason we encrypt to both.
    const asMeV4 = await decryptMessage({ message: await parsePgpMessage(armored), privateKey: mySet.v4.privateKey })
    expect(asMeV4.text).toBe('top secret')
    const asMeV6 = await decryptMessage({ message: await parsePgpMessage(armored), privateKey: mySet.v6.privateKey })
    expect(asMeV6.text).toBe('top secret')
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