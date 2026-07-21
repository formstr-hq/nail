import { describe, it, expect } from 'vitest'
import { replyDraft, replyAllDraft, forwardDraft } from './draft'
import type { Email } from '@/types/mail'

function email(overrides: Partial<Email> = {}): Email {
  return {
    id: 'wrap1',
    messageId: '<m2@mailstr.app>',
    references: ['<m1@mailstr.app>'],
    from: { name: 'Jack', address: 'jack@example.org' },
    to: [{ address: 'me@mailstr.app' }, { address: 'ada@example.org' }],
    subject: 'Seal timestamps drift',
    body: 'Works on my end.\n\n— Jack',
    attachments: [],
    timestamp: 1_700_000_000,
    senderPubkey: 'a'.repeat(64),
    senderProof: 'bridge-seal',
    read: true,
    labelEventIds: [],
    labels: [],
    ...overrides,
  }
}

describe('replyDraft', () => {
  it('addresses the sender and threads the reply', () => {
    const d = replyDraft(email())
    expect(d.to).toBe('jack@example.org')
    expect(d.subject).toBe('Re: Seal timestamps drift')
    expect(d.inReplyTo).toBe('<m2@mailstr.app>')
    // Parent's References plus the parent's own Message-ID (RFC 5322 §3.6.4).
    expect(d.references).toEqual(['<m1@mailstr.app>', '<m2@mailstr.app>'])
  })

  // "Re: Re: Re:" is the classic tell of a client that just concatenates.
  it('does not stack Re: on a subject that already has one', () => {
    expect(replyDraft(email({ subject: 'Re: Seal timestamps' })).subject).toBe(
      'Re: Seal timestamps',
    )
    expect(replyDraft(email({ subject: 'RE : Seal timestamps' })).subject).toBe(
      'RE : Seal timestamps',
    )
  })

  it('quotes the original body', () => {
    expect(replyDraft(email()).body).toContain('> Works on my end.')
  })

  it('omits References entirely when the message has no thread history', () => {
    const d = replyDraft(email({ messageId: undefined, references: undefined }))
    expect(d.references).toBeUndefined()
    expect(d.inReplyTo).toBeUndefined()
  })
})

describe('replyAllDraft', () => {
  it('keeps every other participant and drops the user', () => {
    const d = replyAllDraft(email({ cc: [{ address: 'bob@example.org' }] }), ['me@mailstr.app'])
    expect(d.to).toBe('jack@example.org, ada@example.org, bob@example.org')
  })

  // Address domains are case-insensitive, and every host this bridges to
  // treats the local part that way too.
  it('matches the user’s own address regardless of case', () => {
    const d = replyAllDraft(email(), ['ME@Mailstr.App'])
    expect(d.to).not.toContain('me@mailstr.app')
  })

  it('does not list the same participant twice', () => {
    const d = replyAllDraft(
      email({ to: [{ address: 'ada@example.org' }], cc: [{ address: 'ada@example.org' }] }),
      ['me@mailstr.app'],
    )
    expect(d.to).toBe('jack@example.org, ada@example.org')
  })
})

describe('forwardDraft', () => {
  it('starts an empty recipient list and a new thread', () => {
    const d = forwardDraft(email())
    expect(d.to).toBe('')
    expect(d.subject).toBe('Fwd: Seal timestamps drift')
    // Carrying these would splice the forward into the original conversation.
    expect(d.inReplyTo).toBeUndefined()
    expect(d.references).toBeUndefined()
  })

  it('includes the original headers above the body', () => {
    const d = forwardDraft(email())
    expect(d.body).toContain('---------- Forwarded message ----------')
    expect(d.body).toContain('From: Jack <jack@example.org>')
    expect(d.body).toContain('Works on my end.')
  })

  it('does not stack Fwd: on an already-forwarded subject', () => {
    expect(forwardDraft(email({ subject: 'Fwd: Seal timestamps' })).subject).toBe(
      'Fwd: Seal timestamps',
    )
    expect(forwardDraft(email({ subject: 'FW: Seal timestamps' })).subject).toBe(
      'FW: Seal timestamps',
    )
  })
})
