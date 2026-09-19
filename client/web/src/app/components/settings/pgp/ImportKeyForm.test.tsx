/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/app/components/test-utils'
import { ImportKeyForm } from './ImportKeyForm'
import { generateKey, encryptPrivateKey, readKeyInfo } from '@/app/lib/pgp/openpgp'

const PASS = 'import-pass-1234'
let lockedPrivateKey: string
let lockedFingerprint: string
let unlockedPrivateKey: string

beforeAll(async () => {
  const gen = await generateKey({ email: 'alice@mailstr.app' })
  unlockedPrivateKey = gen.privateKey
  lockedFingerprint = gen.fingerprint
  lockedPrivateKey = await encryptPrivateKey(gen.privateKey, PASS)
}, 30_000)

describe('ImportKeyForm', () => {
  it('asks for the passphrase of a protected key, then stores the UNLOCKED key', async () => {
    const user = userEvent.setup()
    const onSet = vi.fn()
    const onCancel = vi.fn()
    const setError = vi.fn()

    render(
      <ImportKeyForm
        address="alice@mailstr.app"
        onSet={onSet}
        onCancel={onCancel}
        setError={setError}
      />,
    )

    await user.type(
      screen.getByPlaceholderText('-----BEGIN PGP PRIVATE KEY BLOCK-----'),
      lockedPrivateKey,
    )
    await user.click(screen.getByRole('button', { name: /import key/i }))

    // Step 2: the passphrase prompt appears; nothing stored yet.
    await screen.findByPlaceholderText('Key passphrase')
    expect(onSet).not.toHaveBeenCalled()

    await user.type(screen.getByPlaceholderText('Key passphrase'), PASS)
    await user.click(screen.getByRole('button', { name: /unlock & import/i }))

    await vi.waitFor(() => expect(onSet).toHaveBeenCalledTimes(1))
    const stored = onSet.mock.calls[0][0]
    expect(stored.passphraseProtected).toBe(false)
    expect(stored.fingerprint).toBe(lockedFingerprint)
    // What is stored must actually be unlocked — the whole point of the flow.
    expect((await readKeyInfo(stored.privateKey)).encrypted).toBe(false)
    expect(onCancel).toHaveBeenCalled()
  })

  it('surfaces a wrong passphrase and stores nothing', async () => {
    const user = userEvent.setup()
    const onSet = vi.fn()
    const setError = vi.fn()

    render(
      <ImportKeyForm
        address="alice@mailstr.app"
        onSet={onSet}
        onCancel={vi.fn()}
        setError={setError}
      />,
    )

    await user.type(
      screen.getByPlaceholderText('-----BEGIN PGP PRIVATE KEY BLOCK-----'),
      lockedPrivateKey,
    )
    await user.click(screen.getByRole('button', { name: /import key/i }))
    await screen.findByPlaceholderText('Key passphrase')

    await user.type(screen.getByPlaceholderText('Key passphrase'), 'wrong-pass')
    await user.click(screen.getByRole('button', { name: /unlock & import/i }))

    await vi.waitFor(() => expect(setError).toHaveBeenCalled())
    expect(onSet).not.toHaveBeenCalled()
  })

  it('stores an already-unlocked key in one step', async () => {
    const user = userEvent.setup()
    const onSet = vi.fn()

    render(
      <ImportKeyForm
        address="alice@mailstr.app"
        onSet={onSet}
        onCancel={vi.fn()}
        setError={vi.fn()}
      />,
    )

    await user.type(
      screen.getByPlaceholderText('-----BEGIN PGP PRIVATE KEY BLOCK-----'),
      unlockedPrivateKey,
    )
    await user.click(screen.getByRole('button', { name: /import key/i }))

    await vi.waitFor(() => expect(onSet).toHaveBeenCalledTimes(1))
    expect(onSet.mock.calls[0][0].passphraseProtected).toBe(false)
    expect(screen.queryByPlaceholderText('Key passphrase')).not.toBeInTheDocument()
  })

  it('rejects a public key', async () => {
    const user = userEvent.setup()
    const onSet = vi.fn()
    const setError = vi.fn()

    render(
      <ImportKeyForm
        address="alice@mailstr.app"
        onSet={onSet}
        onCancel={vi.fn()}
        setError={setError}
      />,
    )

    // The PUBLIC half of the same key: parsing succeeds, isPrivate is false.
    const { extractPublicKey } = await import('@/app/components/settings/pgp/shared')
    const publicArmor = await extractPublicKey(unlockedPrivateKey)

    await user.type(
      screen.getByPlaceholderText('-----BEGIN PGP PRIVATE KEY BLOCK-----'),
      publicArmor,
    )
    await user.click(screen.getByRole('button', { name: /import key/i }))

    await vi.waitFor(() => expect(setError).toHaveBeenCalled())
    expect(onSet).not.toHaveBeenCalled()
  })
})
