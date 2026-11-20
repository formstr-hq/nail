import { describe, expect, it } from 'vitest'
import {
  groupAddressesByDomain,
  isPinnedInbox,
  normalizePinnedInboxes,
  recentInboxes,
  type AliasInboxStats,
} from './inboxAddresses'

describe('normalizePinnedInboxes', () => {
  it('keeps user order, resolves casing, and drops missing or duplicate pins', () => {
    const aliases = ['alice@mailstr.app', 'bob@acme.com', 'carol@mailstr.app']
    expect(
      normalizePinnedInboxes(
        ['BOB@ACME.COM', 'gone@mailstr.app', 'alice@MAILSTR.APP', 'bob@acme.com'],
        aliases,
      ),
    ).toEqual(['bob@acme.com', 'alice@mailstr.app'])
  })

  it('returns an empty list when nothing is pinned', () => {
    expect(normalizePinnedInboxes(undefined, ['a@mailstr.app'])).toEqual([])
  })

  it('caps the sidebar at the pin limit even if storage has more', () => {
    const aliases = Array.from({ length: 7 }, (_, i) => `a${i}@mailstr.app`)
    expect(normalizePinnedInboxes(aliases, aliases)).toEqual(aliases.slice(0, 5))
  })
})

describe('isPinnedInbox', () => {
  it('compares case-insensitively', () => {
    expect(isPinnedInbox(['Alice@Mailstr.app'], 'alice@mailstr.app')).toBe(true)
    expect(isPinnedInbox(['alice@mailstr.app'], 'bob@mailstr.app')).toBe(false)
  })
})

describe('groupAddressesByDomain', () => {
  it('sorts addresses within each domain and puts domain-less entries last', () => {
    expect(
      groupAddressesByDomain([
        'zoe@work.example',
        'bob@mailstr.app',
        'alice@mailstr.app',
        'solo',
        'amy@work.example',
      ]),
    ).toEqual([
      { domain: 'mailstr.app', addresses: ['alice@mailstr.app', 'bob@mailstr.app'] },
      { domain: 'work.example', addresses: ['amy@work.example', 'zoe@work.example'] },
      { domain: '', addresses: ['solo'] },
    ])
  })
})

describe('recentInboxes', () => {
  const stats = new Map<string, AliasInboxStats>([
    ['a@mailstr.app', { unread: 0, lastAt: 10 }],
    ['b@mailstr.app', { unread: 0, lastAt: 30 }],
    ['c@mailstr.app', { unread: 0, lastAt: 20 }],
    ['d@mailstr.app', { unread: 0, lastAt: 0 }],
  ])

  it('returns the newest addresses first, excluding pins/current and silent aliases', () => {
    expect(
      recentInboxes(
        ['a@mailstr.app', 'b@mailstr.app', 'c@mailstr.app', 'd@mailstr.app'],
        stats,
        new Set(['b@mailstr.app']),
      ),
    ).toEqual(['c@mailstr.app', 'a@mailstr.app'])
  })

  it('breaks timestamp ties alphabetically', () => {
    const tied = new Map<string, AliasInboxStats>([
      ['b@mailstr.app', { unread: 0, lastAt: 10 }],
      ['a@mailstr.app', { unread: 0, lastAt: 10 }],
    ])
    expect(
      recentInboxes(['b@mailstr.app', 'a@mailstr.app'], tied, new Set(), 2),
    ).toEqual(['a@mailstr.app', 'b@mailstr.app'])
  })
})
