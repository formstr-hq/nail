import { describe, it, expect } from 'vitest'
import { deriveContacts, searchContacts } from './contacts'
import type { Email, MailAddress } from '@/app/types/mail'

function email(over: Partial<Email>): Email {
  return {
    id: Math.random().toString(36).slice(2),
    fromHeader: { address: 'a@x.org' },
    senderPubkey: 'a'.repeat(64),
    to: [],
    subject: '',
    body: '',
    attachments: [],
    timestamp: 0,
    read: false,
    labelEventIds: [],
    labels: [],
    ...over,
  }
}

/** An effective-sender map for one message, keyed by id. */
function senders(...entries: Array<[Email, MailAddress]>): Map<string, MailAddress> {
  return new Map(entries.map(([e, from]) => [e.id, from]))
}

describe('deriveContacts', () => {
  it('dedups by address case-insensitively and counts every reference', () => {
    const a = email({ fromHeader: { address: 'Alice@X.org', name: 'Alice' }, timestamp: 1 })
    const b = email({ fromHeader: { address: 'alice@x.org' }, timestamp: 2 }) // same address, bare, later
    const contacts = deriveContacts(
      [a, b],
      [],
      senders([a, { address: 'alice@x.org', name: 'Alice' }], [b, { address: 'alice@x.org' }]),
    )
    expect(contacts).toHaveLength(1)
    expect(contacts[0].count).toBe(2)
    expect(contacts[0].name).toBe('Alice') // name kept even though the 2nd was bare
    expect(contacts[0].lastSeen).toBe(2)
  })

  it('collects from, to, and cc', () => {
    const e = email({
      fromHeader: { address: 'f@x.org' },
      to: [{ address: 't@x.org' }],
      cc: [{ address: 'c@x.org' }],
    })
    const keys = deriveContacts([e], [], senders([e, { address: 'f@x.org' }]))
      .map((c) => c.key)
      .sort()
    expect(keys).toEqual(['c@x.org', 'f@x.org', 't@x.org'])
  })

  it('excludes the user’s own addresses', () => {
    const e = email({ fromHeader: { address: 'me@x.org' }, to: [{ address: 'you@x.org' }] })
    const contacts = deriveContacts(
      [e],
      ['ME@x.org'],
      senders([e, { address: 'me@x.org' }]),
    )
    expect(contacts.map((c) => c.key)).toEqual(['you@x.org'])
  })

  it('ranks by frequency, then recency', () => {
    const a = email({ timestamp: 1 })
    const b = email({ timestamp: 2 })
    const c = email({ timestamp: 9 })
    const d = email({ timestamp: 3 })
    const contacts = deriveContacts(
      [a, b, c, d],
      [],
      senders(
        [a, { address: 'often@x.org' }],
        [b, { address: 'often@x.org' }],
        [c, { address: 'recent@x.org' }],
        [d, { address: 'old@x.org' }],
      ),
    )
    expect(contacts.map((c) => c.key)).toEqual(['often@x.org', 'recent@x.org', 'old@x.org'])
  })

  // The security property: a message whose proof is unsettled must contribute
  // its sealing key, never the header it claims.
  it('falls back to the npub, never the claimed header, when no effective sender is known', () => {
    const e = email({ fromHeader: { address: 'ceo@company.com' }, senderPubkey: 'd'.repeat(64) })
    const [contact] = deriveContacts([e])
    expect(contact.address.startsWith('npub1')).toBe(true)
    expect(contact.address).not.toContain('ceo@company.com')
  })

  it('uses the effective sender when supplied', () => {
    const e = email({ fromHeader: { address: 'ceo@company.com' } })
    const [contact] = deriveContacts([e], [], senders([e, { address: 'real@x.org' }]))
    expect(contact.address).toBe('real@x.org')
  })
})

describe('searchContacts', () => {
  const mk = (name: string, address: string) =>
    email({ fromHeader: { address, name } })
  const a = mk('Alice Cooper', 'alice@x.org')
  const b = mk('Bob', 'bob@y.org')

  const contacts = deriveContacts(
    [a, b],
    [],
    senders([a, { address: 'alice@x.org', name: 'Alice Cooper' }], [b, { address: 'bob@y.org', name: 'Bob' }]),
  )

  it('matches on name or address', () => {
    expect(searchContacts(contacts, 'cooper').map((c) => c.key)).toEqual(['alice@x.org'])
    expect(searchContacts(contacts, 'y.org').map((c) => c.key)).toEqual(['bob@y.org'])
  })

  it('returns top contacts for an empty query and respects the limit', () => {
    expect(searchContacts(contacts, '  ')).toHaveLength(2)
    expect(searchContacts(contacts, '', 1)).toHaveLength(1)
  })
})
