import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store imports the settings lib, which reaches the relay worker via
// localRelay. Stub it so these tests exercise only the store's save semantics.
vi.mock('@/app/lib/nostr/settings', () => ({
  saveSettings: vi.fn(),
  loadSettingsDetailed: vi.fn(),
}))

import { saveSettings } from '@/app/lib/nostr/settings'
import { useSettingsStore } from './settings'
import type { ActiveSigner } from '@formstr/signer'

const ACTIVE = {} as ActiveSigner
const PUBKEY = 'a'.repeat(64)

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.getState().reset()
})

describe('settings store save', () => {
  it('commits the merged settings only after the publish succeeds', async () => {
    let resolvePublish: () => void = () => {}
    vi.mocked(saveSettings).mockImplementation(
      () => new Promise<void>((resolve) => (resolvePublish = resolve)),
    )

    const savePromise = useSettingsStore.getState().save({ signature: 'Regards' }, PUBKEY, ACTIVE)

    // Wait for the serialized chain to actually call publish, then confirm the
    // store has not committed yet.
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(useSettingsStore.getState().settings.signature).toBeUndefined()

    resolvePublish()
    await savePromise
    expect(useSettingsStore.getState().settings.signature).toBe('Regards')
  })

  it('does not commit a patch whose publish failed (B5)', async () => {
    vi.mocked(saveSettings).mockRejectedValue(new Error('no relay accepted the event'))

    await expect(
      useSettingsStore.getState().save({ mailIndexKey: 'f'.repeat(64) }, PUBKEY, ACTIVE),
    ).rejects.toThrow('no relay accepted the event')

    expect(useSettingsStore.getState().settings.mailIndexKey).toBeUndefined()
  })

  it('merges a stale patch into the live blob instead of replacing it (B6)', async () => {
    vi.mocked(saveSettings).mockResolvedValue(undefined)

    // A user edit lands first…
    useSettingsStore.getState().update({ signature: 'Alice' })
    // …then a slow background writer saves only the field it owns.
    await useSettingsStore.getState().save({ pgpKeyring: { k: 'v' } }, PUBKEY, ACTIVE)

    const s = useSettingsStore.getState().settings
    expect(s.signature).toBe('Alice')
    expect(s.pgpKeyring).toEqual({ k: 'v' })
    // The publish carries both, not a blob missing the signature.
    const published = vi.mocked(saveSettings).mock.calls[0][0]
    expect(published.signature).toBe('Alice')
    expect(published.pgpKeyring).toEqual({ k: 'v' })
  })

  it('serializes concurrent saves so the second sees the first result', async () => {
    const order: string[] = []
    vi.mocked(saveSettings).mockImplementation(async (settings) => {
      order.push(settings.signature ?? '(none)')
    })

    await Promise.all([
      useSettingsStore.getState().save({ signature: 'one' }, PUBKEY, ACTIVE),
      useSettingsStore.getState().save({ pgpKeyring: { k: 'v' } }, PUBKEY, ACTIVE),
    ])
    // The second publish must include the first save's signature.
    expect(order[1]).toBe('one')
  })

  it('reset clears account-scoped settings (B1)', () => {
    useSettingsStore.getState().update({ signature: 'Alice', mailIndexKey: 'x' })
    useSettingsStore.getState().reset()
    const s = useSettingsStore.getState()
    expect(s.settings).toEqual({})
    expect(s.loaded).toBe(false)
    expect(s.eventExists).toBe(false)
  })
})
