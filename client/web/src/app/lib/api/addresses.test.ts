import { describe, expect, it } from 'vitest'
import { normalizeOwnedAddresses } from './addresses'

// The bug this guards: the get-nip05 response gives a NIP-05 `name` (bare
// localpart). Left bare it flows into the Settings sender picker and then
// fails the `splitAddress`-based ownership check in send.ts, blocking sends.
describe('normalizeOwnedAddresses', () => {
  it('qualifies a bare localpart with the bridge domain', () => {
    expect(normalizeOwnedAddresses([{ name: 'abhay' }])).toEqual(['abhay@mailstr.app'])
  })

  it('qualifies a bare string entry', () => {
    expect(normalizeOwnedAddresses('abhay')).toEqual(['abhay@mailstr.app'])
    expect(normalizeOwnedAddresses(['abhay'])).toEqual(['abhay@mailstr.app'])
  })

  it('leaves an already-qualified address untouched', () => {
    expect(normalizeOwnedAddresses([{ nip05: 'abhay@mailstr.app' }])).toEqual([
      'abhay@mailstr.app',
    ])
    expect(normalizeOwnedAddresses({ nip05: 'me@example.org' })).toEqual(['me@example.org'])
  })

  it('handles nip05Addresses arrays and mixed bare/qualified entries', () => {
    expect(
      normalizeOwnedAddresses({ nip05Addresses: ['abhay', 'me@example.org'] }),
    ).toEqual(['abhay@mailstr.app', 'me@example.org'])
  })

  it('returns [] for unrecognized shapes', () => {
    expect(normalizeOwnedAddresses(null)).toEqual([])
    expect(normalizeOwnedAddresses(42)).toEqual([])
    expect(normalizeOwnedAddresses({})).toEqual([])
  })
})
