import { describe, it, expect } from 'vitest'
import { matchesAlias } from './aliasFilter'
import type { Email } from '@/types/mail'

function email(over: Partial<Email>): Email {
  return {
    id: Math.random().toString(36).slice(2),
    from: { address: 'sender@x.org' },
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

describe('matchesAlias', () => {
  it('keeps every message when the filter is null (all mail)', () => {
    expect(matchesAlias(email({ to: [{ address: 'me@x.org' }] }), null)).toBe(true)
  })

  it('matches an alias against a To recipient', () => {
    const e = email({ to: [{ address: 'other@x.org' }, { address: 'alias@x.org' }] })
    expect(matchesAlias(e, 'alias@x.org')).toBe(true)
    expect(matchesAlias(e, 'missing@x.org')).toBe(false)
  })

  it('matches an alias carried only in Cc', () => {
    const e = email({ to: [{ address: 'other@x.org' }], cc: [{ address: 'alias@x.org' }] })
    expect(matchesAlias(e, 'alias@x.org')).toBe(true)
  })

  it('matches our own sent copy by its From address', () => {
    const e = email({ from: { address: 'alias@x.org' }, to: [{ address: 'friend@y.org' }] })
    expect(matchesAlias(e, 'alias@x.org')).toBe(true)
  })

  it('is case-insensitive (the store lowercases the filter)', () => {
    const e = email({ to: [{ address: 'Alias@X.org' }] })
    expect(matchesAlias(e, 'alias@x.org')).toBe(true)
  })
})
