import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

/**
 * Shared setup for component tests (happy-dom docblock tests).
 *
 * The mail/account stores reach for localStorage at module load and on every
 * write, so tests stub it before importing the component under test.
 */

// A minimal localStorage shim (happy-dom provides one, but stubbing keeps the
// storage clean between tests without reloading modules).
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => void storage.clear(),
})

// The composer reads matchMedia for its outside-click-to-minimize behavior.
vi.stubGlobal(
  'matchMedia',
  vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
)

// Mail actions optimistically publish metadata in the background; in tests
// there is no relay worker, so the publish path is mocked to a silent no-op.
vi.mock('@/app/lib/nostr/mailMeta', () => ({
  publishMailMeta: vi.fn().mockResolvedValue(undefined),
  randomMailIndexKey: vi.fn().mockReturnValue('0'.repeat(64)),
}))
vi.mock('@/app/lib/nostr/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/nostr/settings')>()),
  loadSettingsDetailed: vi.fn().mockResolvedValue({ settings: {}, found: true, version: undefined }),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}))

// Sender-proof derivation probes NIP-05 per claimed address. In component
// tests the network is absent, so a probe would sit for its full timeout and
// leave rows stuck on "checking". Stub it to a cached negative (and the peek
// to match), so an unproven sender settles to the key immediately; individual
// tests seed the bridge store when they need a resolved proof.
vi.mock('@/app/lib/nostr/nip05', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/nostr/nip05')>()),
  probeNip05: vi.fn().mockResolvedValue(null),
  peekNip05: vi.fn().mockReturnValue({ pubkey: null }),
}))

afterEach(() => {
  cleanup()
  storage.clear()
})