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

  // A workspace address comes back as {nip05:'alice', domain:'acme.com'} from
  // the backend's get-nip05. Qualifying it with BRIDGE_DOMAIN would turn it
  // into alice@mailstr.app — a different, wrong address.
  it('uses the entry domain for a workspace address instead of BRIDGE_DOMAIN', () => {
    expect(
      normalizeOwnedAddresses([
        { nip05: 'alice', domain: 'acme.com' },
        { nip05: 'bob', domain: 'hllo.live' },
      ]),
    ).toEqual(['alice@acme.com', 'bob@hllo.live'])
  })

  it('still qualifies a domainless entry with BRIDGE_DOMAIN', () => {
    expect(normalizeOwnedAddresses([{ nip05: 'abhay', domain: null }])).toEqual([
      'abhay@mailstr.app',
    ])
    expect(normalizeOwnedAddresses([{ name: 'abhay' }])).toEqual(['abhay@mailstr.app'])
  })

  it('prefers an already-qualified nip05 over the domain field', () => {
    expect(
      normalizeOwnedAddresses([{ nip05: 'alice@acme.com', domain: 'ignored.com' }]),
    ).toEqual(['alice@acme.com'])
  })

  it('returns [] for unrecognized shapes', () => {
    expect(normalizeOwnedAddresses(null)).toEqual([])
    expect(normalizeOwnedAddresses(42)).toEqual([])
    expect(normalizeOwnedAddresses({})).toEqual([])
  })
})
