import { beforeEach, describe, expect, it, vi } from 'vitest'

// account.ts reaches the signer package, the relay worker, and the mail store;
// stub the relay layer so the module imports cleanly in node.
vi.mock('@/app/lib/nostr/localRelay', () => ({
  resetLocalRelay: vi.fn(),
  getLocalRelay: vi.fn(),
  syncAccountRelays: vi.fn(() => ({ unobserve: vi.fn() })),
  localRelayBootError: vi.fn(() => null),
  queryLocal: vi.fn(async () => []),
}))

import { resetAccountScopedState } from './account'
import { useMailStore } from './mail'
import { useSettingsStore } from './settings'
import { useComposeOverlay } from './composeOverlay'
import { useBuyOverlay } from './buyOverlay'
import { setSessionPassphrase, getSessionPassphrase } from '@/app/lib/pgp/session'
import { resetLocalRelay } from '@/app/lib/nostr/localRelay'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resetAccountScopedState (B1)', () => {
  it('clears mail, settings, overlays, PGP passphrases and the relay worker', () => {
    useMailStore.setState({ selectedId: 'x', folder: 'trash' })
    useSettingsStore.getState().update({ signature: 'Alice', mailIndexKey: 'k' })
    useComposeOverlay.getState().open({ to: 'bob@x.com', subject: 'draft', body: 'secret' })
    useBuyOverlay.getState().open()
    setSessionPassphrase('fp1', 'hunter2')

    resetAccountScopedState()

    expect(useMailStore.getState().selectedId).toBeNull()
    expect(useSettingsStore.getState().settings).toEqual({})
    expect(useComposeOverlay.getState().draft).toBeNull()
    expect(useBuyOverlay.getState().visible).toBe(false)
    expect(getSessionPassphrase('fp1')).toBeNull()
    expect(resetLocalRelay).toHaveBeenCalled()
  })
})
