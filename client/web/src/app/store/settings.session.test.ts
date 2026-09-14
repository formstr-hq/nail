import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/lib/nostr/settings', () => ({
  saveSettings: vi.fn(),
  loadSettingsDetailed: vi.fn(),
}))

import { saveSettings, loadSettingsDetailed } from '@/app/lib/nostr/settings'
import { useSettingsStore } from './settings'
import { bumpSessionEpoch } from './sessionEpoch'
import type { ActiveSigner } from '@formstr/signer'

const ACTIVE = {} as ActiveSigner
const PUBKEY = 'a'.repeat(64)

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.getState().reset()
})

/** The reset in beforeEach must not leak epoch state between tests. */
beforeEach(() => {
  bumpSessionEpoch()
})

describe('settings store session guarding', () => {
  it('does not commit a load that resolves after an account switch', async () => {
    let resolveLoad: (v: Awaited<ReturnType<typeof loadSettingsDetailed>>) => void = () => {}
    vi.mocked(loadSettingsDetailed).mockImplementation(
      () => new Promise((resolve) => (resolveLoad = resolve)),
    )

    const loading = useSettingsStore.getState().load(PUBKEY, ACTIVE)
    // The switch happens while the load is in flight.
    bumpSessionEpoch()
    useSettingsStore.getState().reset()

    resolveLoad({ settings: { signature: 'old account' }, eventExists: true, version: 1 })
    await loading

    // The old account's settings must not be installed into the new session.
    expect(useSettingsStore.getState().settings).toEqual({})
    expect(useSettingsStore.getState().loaded).toBe(false)
  })

  it('does not commit a save that resolves after an account switch', async () => {
    vi.mocked(saveSettings).mockResolvedValue(undefined)

    const saving = useSettingsStore.getState().save({ signature: 'old' }, PUBKEY, ACTIVE)
    bumpSessionEpoch()
    useSettingsStore.getState().reset()
    await saving

    expect(useSettingsStore.getState().settings).toEqual({})
  })
})
