import { describe, it, expect } from 'vitest'
import type { Email, FolderEntry } from '@/app/types/mail'
import {
  DEFAULT_FOLDERS,
  colorForId,
  folderName,
  foldersOf,
  matchesMatch,
  newEntryId,
  resolveFolder,
  resolveLabels,
  sortFolders,
  spamFromHeaders,
  validateEntry,
} from './folders'

function email(over: Partial<Email> = {}): Email {
  return {
    id: 'm1',
    fromHeader: { address: 'alice@example.com' },
    to: [{ address: 'me@mailstr.app' }],
    subject: 'Quarterly invoice',
    body: 'body',
    attachments: [],
    timestamp: 1,
    senderPubkey: 'p'.repeat(64),
    read: false,
    labelEventIds: [],
    labels: [],
    ...over,
  }
}

const attachment = { filename: 'a.pdf', contentType: 'application/pdf' }

describe('folder definitions', () => {
  it('falls back to the defaults when settings carry none', () => {
    expect(foldersOf({})).toEqual(DEFAULT_FOLDERS)
    expect(foldersOf({ folders: [] })).toEqual(DEFAULT_FOLDERS)
  })

  it('uses saved definitions when present', () => {
    const folders = [
      { id: 'inbox', name: 'Inbox' },
      { id: 'sent', name: 'Sent' },
      { id: 'x', name: 'X' },
    ]
    expect(foldersOf({ folders })).toEqual(folders)
  })

  it('keeps the natural mailboxes when another client omitted them', () => {
    const ids = foldersOf({ folders: [{ id: 'billing', name: 'Billing' }] }).map((f) => f.id)
    expect(ids).toContain('billing')
    expect(ids).toContain('inbox')
    expect(ids).toContain('sent')
  })

  it('sorts by position, absent last, ties by name then id', () => {
    const sorted = sortFolders([
      { id: 'c', name: 'C' },
      { id: 'b', name: 'B', position: 2 },
      { id: 'a', name: 'A', position: 1 },
      { id: 'a2', name: 'A', position: 2 },
    ])
    expect(sorted.map((f) => f.id)).toEqual(['a', 'a2', 'b', 'c'])
  })
})

describe('match semantics', () => {
  it('matches sender exactly, by domain, and by subdomain', () => {
    expect(matchesMatch({ from: ['alice@example.com'] }, email())).toBe(true)
    expect(matchesMatch({ from: ['example.com'] }, email())).toBe(true)
    expect(matchesMatch({ from: ['mail.example.com'] }, email({ fromHeader: { address: 'a@mail.example.com' } }))).toBe(true)
    expect(matchesMatch({ from: ['other.com'] }, email())).toBe(false)
  })

  it('ORs entries within a field and ANDs fields', () => {
    expect(matchesMatch({ from: ['no.com', 'example.com'] }, email())).toBe(true)
    expect(matchesMatch({ from: ['example.com'], subject: ['invoice'] }, email())).toBe(true)
    expect(matchesMatch({ from: ['example.com'], subject: ['missing'] }, email())).toBe(false)
  })

  it('matches subject case-insensitively by substring', () => {
    expect(matchesMatch({ subject: ['INVOICE'] }, email())).toBe(true)
    expect(matchesMatch({ subject: ['nope'] }, email())).toBe(false)
  })

  it('matches attachment presence in both directions', () => {
    expect(matchesMatch({ has_attachment: true }, email({ attachments: [attachment] }))).toBe(true)
    expect(matchesMatch({ has_attachment: true }, email())).toBe(false)
    expect(matchesMatch({ has_attachment: false }, email())).toBe(true)
  })

  it('matches the derived spam flag in both directions', () => {
    expect(matchesMatch({ spam: true }, email({ spam: true }))).toBe(true)
    expect(matchesMatch({ spam: true }, email())).toBe(false)
    expect(matchesMatch({ spam: false }, email())).toBe(true)
  })

  it('matches nothing when no condition is present', () => {
    expect(matchesMatch({}, email())).toBe(false)
    expect(matchesMatch(undefined, email())).toBe(false)
  })
})

describe('resolveFolder', () => {
  const folders: FolderEntry[] = [
    { id: 'inbox', name: 'Inbox', position: 0 },
    { id: 'billing', name: 'Billing', position: 1, match: { subject: ['invoice'] } },
    { id: 'spam', name: 'Spam', position: 2, match: { spam: true } },
    { id: 'archive', name: 'Archive', position: 3 },
  ]

  it('uses the first matching folder by position', () => {
    expect(resolveFolder(email(), undefined, folders)).toBe('billing')
    expect(
      resolveFolder(email({ spam: true, subject: 'unrelated' }), undefined, folders),
    ).toBe('spam')
  })

  it('prefers a later match over an earlier non-match only', () => {
    const overlap: FolderEntry[] = [
      { id: 'first', name: 'First', position: 0, match: { from: ['example.com'] } },
      { id: 'second', name: 'Second', position: 1, match: { subject: ['invoice'] } },
    ]
    expect(resolveFolder(email(), undefined, overlap)).toBe('first')
  })

  it('lets an explicit folder win over every match', () => {
    expect(resolveFolder(email(), { folder: 'archive', updatedAt: 0 }, folders)).toBe('archive')
  })

  it('lets an explicit inbox override the spam match', () => {
    // This is "Not spam": the only way to rescue a matched message.
    expect(resolveFolder(email({ spam: true }), { folder: 'inbox', updatedAt: 0 }, folders)).toBe('inbox')
  })

  it('returns undefined when nothing matches', () => {
    expect(resolveFolder(email({ subject: 'hi' }), undefined, folders)).toBeUndefined()
  })
})

describe('resolveLabels', () => {
  const labels = [
    { id: 'invoice', name: 'Invoice', match: { subject: ['invoice'] } },
    { id: 'from-alice', name: 'Alice', match: { from: ['example.com'] } },
  ]

  it('unions explicit labels with matched labels', () => {
    expect(resolveLabels(email(), { labels: ['manual'], updatedAt: 0 }, labels).sort()).toEqual(
      ['from-alice', 'invoice'],
    )
  })

  it('keeps explicit labels while definitions are still loading', () => {
    expect(resolveLabels(email(), { labels: ['manual'], updatedAt: 0 }, [])).toEqual(['manual'])
  })

  it('is stable and de-duplicates', () => {
    const result = resolveLabels(email(), { labels: ['invoice'], updatedAt: 0 }, labels)
    expect(result.filter((id) => id === 'invoice')).toHaveLength(1)
  })
})

describe('spamFromHeaders', () => {
  it('prefers the bridge marker in both directions', () => {
    expect(
      spamFromHeaders([
        { key: 'X-Spam-Flag', value: 'YES' },
        { key: 'X-Bridge-Spam', value: 'no' },
      ]),
    ).toBe(false)
    expect(
      spamFromHeaders([
        { key: 'X-Spam-Flag', value: 'NO' },
        { key: 'X-Bridge-Spam', value: 'yes' },
      ]),
    ).toBe(true)
  })

  it('falls back to X-Spam-Flag', () => {
    expect(spamFromHeaders([{ key: 'x-spam-flag', value: 'Yes' }])).toBe(true)
    expect(spamFromHeaders([{ key: 'x-spam-flag', value: 'NO' }])).toBe(false)
    expect(spamFromHeaders([])).toBe(false)
    expect(spamFromHeaders(undefined)).toBe(false)
  })
})

describe('editor helpers', () => {
  it('derives stable, unique ids from names', () => {
    expect(newEntryId('Receipts 2026', [])).toBe('receipts-2026')
    expect(newEntryId('Receipts 2026', ['receipts-2026'])).toBe('receipts-2026-2')
    expect(newEntryId('!!!', [])).toBe('folder')
  })

  it('validates required fields and unique names', () => {
    const existing = [{ id: 'a', name: 'Billing' }]
    expect(validateEntry({ id: 'b', name: 'Billing' }, existing)).toMatch(/unique/)
    expect(validateEntry({ id: 'b', name: '' }, existing)).toMatch(/required/)
    expect(validateEntry({ id: 'b', name: 'x'.repeat(65) }, existing)).toMatch(/64/)
    expect(validateEntry({ id: 'b', name: 'Ops' }, existing)).toBeUndefined()
  })

  it('derives a colour from the id', () => {
    expect(colorForId('spam')).toMatch(/^#[0-9a-f]{6}$/)
    expect(colorForId('spam')).toBe(colorForId('spam'))
  })

  it('finds a folder name', () => {
    expect(folderName(DEFAULT_FOLDERS, 'spam')).toBe('Spam')
    expect(folderName(DEFAULT_FOLDERS, 'nope')).toBeUndefined()
  })
})
