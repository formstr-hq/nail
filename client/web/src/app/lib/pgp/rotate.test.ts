import { describe, it, expect, vi } from 'vitest'
import { rotateAliasKey } from './rotate'
import { ownPublicKeysFor } from './keyring'
import { readKeyInfo } from './openpgp'

describe('rotateAliasKey', () => {
  it('generates a new dual set, saves it, then publishes both public halves', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const publish = vi.fn().mockResolvedValue(undefined)

    const result = await rotateAliasKey({ address: 'alice@mailstr.app', save, publish })

    expect(result.published).toBe(true)
    expect(result.publishError).toBeUndefined()

    // A full dual set bound to the same address, stored UNLOCKED.
    expect(result.keypair.v4 && result.keypair.v6).toBeTruthy()
    expect(result.keypair.passphraseProtected).toBe(false)
    const info = await readKeyInfo(result.keypair.privateKey)
    expect(info.encrypted).toBe(false)
    expect(info.emails).toEqual(['alice@mailstr.app'])

    // Saved before published, and published exactly what was saved.
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(result.keypair)
    expect(publish).toHaveBeenCalledWith('alice@mailstr.app', ownPublicKeysFor(result.keypair))
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0])
  })

  it('aborts before publishing when the save fails', async () => {
    const save = vi.fn().mockRejectedValue(new Error('relay refused settings'))
    const publish = vi.fn()

    await expect(
      rotateAliasKey({ address: 'alice@mailstr.app', save, publish }),
    ).rejects.toThrow('relay refused settings')
    expect(publish).not.toHaveBeenCalled()
  })

  it('keeps the rotated key when the publish fails and reports why', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const publish = vi.fn().mockRejectedValue(new Error('WKD publish failed (503)'))

    const result = await rotateAliasKey({ address: 'alice@mailstr.app', save, publish })

    expect(result.published).toBe(false)
    expect(result.publishError).toBe('WKD publish failed (503)')
    // The new key is still the saved one — Republish-to-WKD retries it, rather
    // than the rotation being rolled back to a key the user just rotated away.
    expect(save).toHaveBeenCalledWith(result.keypair)
  })

  it('returns a fresh, distinct keypair from the previous key', async () => {
    const first = await rotateAliasKey({
      address: 'alice@mailstr.app',
      save: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
    })
    const second = await rotateAliasKey({
      address: 'alice@mailstr.app',
      save: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
    })
    expect(second.keypair.fingerprint).not.toBe(first.keypair.fingerprint)
    expect(second.keypair.publicKey).not.toBe(first.keypair.publicKey)
  }, 30_000)
})
