import { describe, it, expect } from 'vitest'
import { deriveContacts, searchContacts } from './contacts'
import type { Email } from '@/types/mail'

function email(over: Partial<Email>): Email {
  return {
    id: Math.random().toString(36).slice(2),
    from: { address: 'a@x.org' },
    to: [],
    subject: '',
    body: '',
    attachments: [],
    timestamp: 0,
    senderPubkey: '',
    senderProof: 'none',
    read: false,
    labelEventIds: [],
    labels: [],
    ...over,
  }
}

describe('deriveContacts', () => {
  it('dedups by address case-insensitively and counts every reference', () => {
    const contacts = deriveContacts([
      email({ from: { address: 'Alice@X.org', name: 'Alice' }, timestamp: 1 }),
      email({ from: { address: 'alice@x.org' }, timestamp: 2 }), // same address, bare, later
    ])
    expect(contacts).toHaveLength(1)
    expect(contacts[0].count).toBe(2)
    expect(contacts[0].name).toBe('Alice') // name kept even though the 2nd was bare
    expect(contacts[0].lastSeen).toBe(2)
  })

  it('collects from, to, and cc', () => {
    const keys = deriveContacts([
      email({
        from: { address: 'f@x.org' },
        to: [{ address: 't@x.org' }],
        cc: [{ address: 'c@x.org' }],
      }),
    ])
      .map((c) => c.key)
      .sort()
    expect(keys).toEqual(['c@x.org', 'f@x.org', 't@x.org'])
  })

  it('excludes the user’s own addresses', () => {
    const contacts = deriveContacts(
      [email({ from: { address: 'me@x.org' }, to: [{ address: 'you@x.org' }] })],
      ['ME@x.org'],
    )
    expect(contacts.map((c) => c.key)).toEqual(['you@x.org'])
  })

  it('ranks by frequency, then recency', () => {
    const contacts = deriveContacts([
      email({ from: { address: 'often@x.org' }, timestamp: 1 }),
      email({ from: { address: 'often@x.org' }, timestamp: 2 }),
      email({ from: { address: 'recent@x.org' }, timestamp: 9 }),
      email({ from: { address: 'old@x.org' }, timestamp: 3 }),
    ])
    expect(contacts.map((c) => c.key)).toEqual(['often@x.org', 'recent@x.org', 'old@x.org'])
  })
})

describe('searchContacts', () => {
  const contacts = deriveContacts([
    email({ from: { address: 'alice@x.org', name: 'Alice Cooper' } }),
    email({ from: { address: 'bob@y.org', name: 'Bob' } }),
  ])

  it('matches on name or address', () => {
    expect(searchContacts(contacts, 'cooper').map((c) => c.key)).toEqual(['alice@x.org'])
    expect(searchContacts(contacts, 'y.org').map((c) => c.key)).toEqual(['bob@y.org'])
  })

  it('returns top contacts for an empty query and respects the limit', () => {
    expect(searchContacts(contacts, '  ')).toHaveLength(2)
    expect(searchContacts(contacts, '', 1)).toHaveLength(1)
  })
})
