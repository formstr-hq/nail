import { describe, it, expect, vi } from 'vitest'
import { installAliasKey, keypairFromSet, type InstallResult } from './install'
import { generateKeySet, readKeyInfo } from './openpgp'

async function makeKeypair(address: string) {
  return keypairFromSet(await generateKeySet({ email: address }))
}

/** Assert-then-narrow, so the fields are typed at the call sites. */
function expectFailed(result: InstallResult) {
  expect(result.status).toBe('failed')
  if (result.status !== 'failed') throw new Error('unreachable')
  return result
}

describe('installAliasKey', () => {
  it('saves first, then publishes both public halves, and reports installed', async () => {
    const keypair = await makeKeypair('alice@mailstr.app')
    const order: string[] = []
    const save = vi.fn(async () => void order.push('save'))
    const publish = vi.fn(async () => void order.push('publish'))

    const result = await installAliasKey({ address: 'alice@mailstr.app', keypair, save, publish })

    expect(result).toEqual({ status: 'installed' })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(keypair)
    expect(publish).toHaveBeenCalledWith('alice@mailstr.app', [
      keypair.v4!.publicKey,
      keypair.v6!.publicKey,
    ])
    // Never publish a key that is not yet stored.
    expect(order).toEqual(['save', 'publish'])
  })

  it('does not touch the alias when the save fails', async () => {
    const keypair = await makeKeypair('alice@mailstr.app')
    const save = vi.fn().mockRejectedValue(new Error('relay refused settings'))
    const publish = vi.fn()

    const result = expectFailed(
      await installAliasKey({ address: 'alice@mailstr.app', keypair, save, publish }),
    )

    expect(result.saved).toBe(false)
    expect(result.error).toBe('relay refused settings')
    expect(publish).not.toHaveBeenCalled()
  })

  it('rolls a fresh key back out of settings when the publish fails', async () => {
    const keypair = await makeKeypair('alice@mailstr.app')
    const save = vi.fn().mockResolvedValue(undefined)
    const publish = vi.fn().mockRejectedValue(new Error('WKD publish failed (403)'))

    const result = expectFailed(
      await installAliasKey({ address: 'alice@mailstr.app', keypair, save, publish }),
    )

    expect(result.saved).toBe(false)
    expect(result.error).toBe('WKD publish failed (403)')
    // save(new key) then the rollback save(null): no key remains for an alias
    // that had none, so no unpublished key is left behind either.
    expect(save.mock.calls.map((c) => c[0])).toEqual([keypair, null])
  })

  it('restores the previous keypair when rotating and the publish fails', async () => {
    const previous = await makeKeypair('alice@mailstr.app')
    const fresh = await makeKeypair('alice@mailstr.app')
    const save = vi.fn().mockResolvedValue(undefined)
    const publish = vi.fn().mockRejectedValue(new Error('network down'))

    const result = expectFailed(
      await installAliasKey({ address: 'alice@mailstr.app', keypair: fresh, previous, save, publish }),
    )

    expect(result.saved).toBe(false)
    expect(save.mock.calls.map((c) => c[0])).toEqual([fresh, previous])
  })

  it('keeps the stored key and warns when the rollback itself fails', async () => {
    const keypair = await makeKeypair('alice@mailstr.app')
    const save = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('session expired'))
    const publish = vi.fn().mockRejectedValue(new Error('WKD publish failed (503)'))

    const result = expectFailed(
      await installAliasKey({ address: 'alice@mailstr.app', keypair, save, publish }),
    )

    expect(result.saved).toBe(true)
    expect(result.error).toContain('WKD publish failed (503)')
    expect(result.error).toContain('session expired')
  })

  it('stores dual halves bound to the alias, unlocked', async () => {
    const keypair = await makeKeypair('alice@mailstr.app')
    const save = vi.fn().mockResolvedValue(undefined)
    const publish = vi.fn().mockResolvedValue(undefined)

    await installAliasKey({ address: 'alice@mailstr.app', keypair, save, publish })

    expect(keypair.v4 && keypair.v6).toBeTruthy()
    expect(keypair.fingerprint).toBe(keypair.v4!.fingerprint)
    expect(keypair.passphraseProtected).toBe(false)
    const info = await readKeyInfo(keypair.privateKey)
    expect(info.encrypted).toBe(false)
    expect(info.emails).toEqual(['alice@mailstr.app'])
  }, 30_000)
})
