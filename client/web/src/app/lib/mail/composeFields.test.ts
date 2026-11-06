import { describe, expect, it } from 'vitest'
import {
  splitRecipients,
  signatureBlock,
  parseRecipients,
  deriveFromAddress,
  deriveFromOptions,
  hasKnownLegacyRecipient,
  isNpubSender,
  isSendableAddress,
} from './composeFields'

const NPUB = 'npub1' + 'q'.repeat(58)

describe('splitRecipients', () => {
  it('returns the whole string as the token when there is no comma', () => {
    expect(splitRecipients('bob@x.com')).toEqual({ head: '', token: 'bob@x.com' })
  })

  it('splits after the last comma and trims the token', () => {
    expect(splitRecipients('a@x.com, b@y.com, ca')).toEqual({
      head: 'a@x.com, b@y.com,',
      token: 'ca',
    })
  })

  it('trims leading whitespace of the token only', () => {
    expect(splitRecipients('a@x.com,  ')).toEqual({ head: 'a@x.com,', token: '' })
  })
})

describe('signatureBlock', () => {
  it('emits the RFC 3676 delimiter with trailing space', () => {
    expect(signatureBlock('Regards')).toBe('\n\n-- \nRegards')
  })

  it('is empty for blank signatures', () => {
    expect(signatureBlock(undefined)).toBe('')
    expect(signatureBlock('   ')).toBe('')
  })
})

describe('parseRecipients', () => {
  it('trims, drops empties', () => {
    expect(parseRecipients(' a@x.com , ,b@y.com ')).toEqual(['a@x.com', 'b@y.com'])
  })

  it('drops duplicate addresses case-insensitively, keeping first spelling', () => {
    expect(parseRecipients('A@x.com, a@X.com, b@y.com, B@y.com')).toEqual([
      'A@x.com',
      'b@y.com',
    ])
  })
})

describe('isSendableAddress', () => {
  it('rejects the npub mailbox, bare npubs and empty values; accepts aliases', () => {
    expect(isSendableAddress(`${NPUB}@mailstr.app`)).toBe(false)
    expect(isSendableAddress(NPUB)).toBe(false)
    expect(isSendableAddress('alice@mailstr.app')).toBe(true)
    expect(isSendableAddress('')).toBe(false)
  })
})

describe('deriveFromAddress', () => {
  const base = {
    inboxFilter: '',
    selfAddresses: [`${NPUB}@mailstr.app`, 'alice@mailstr.app'],
    senderAddress: undefined as string | undefined,
    ownedAliases: ['alice@mailstr.app'],
  }

  it('prefers the active inbox when it matches an owned address', () => {
    expect(deriveFromAddress({ ...base, inboxFilter: 'ALICE@mailstr.app' })).toBe(
      'alice@mailstr.app',
    )
  })

  it('ignores an inbox filter that matches nothing owned', () => {
    expect(deriveFromAddress({ ...base, inboxFilter: 'ghost@mailstr.app' })).toBe(
      'alice@mailstr.app',
    )
  })

  // A reply pins the mailbox that received the original, even when the
  // sidebar is pointing somewhere else. This is the user's identity to the
  // correspondent, so it outranks every other candidate.
  it('prefers the reply’s delivered-to address over the inbox filter', () => {
    expect(
      deriveFromAddress({
        ...base,
        preferredFrom: 'bob@mailstr.app',
        inboxFilter: 'alice@mailstr.app',
        selfAddresses: [`${NPUB}@mailstr.app`, 'alice@mailstr.app', 'bob@mailstr.app'],
        ownedAliases: ['alice@mailstr.app', 'bob@mailstr.app'],
      }),
    ).toBe('bob@mailstr.app')
  })

  it('ignores a preferred From the account does not own', () => {
    expect(deriveFromAddress({ ...base, preferredFrom: 'ghost@mailstr.app' })).toBe(
      'alice@mailstr.app',
    )
  })

  // The npub bridge address has no NIP-05 row and cannot hold a key, so it is
  // never a legal sender — not even as a saved default or an inbox filter.
  it('never selects the npub, even when it is the filter or saved sender', () => {
    expect(
      deriveFromAddress({ ...base, inboxFilter: `${NPUB}@mailstr.app` }),
    ).toBe('alice@mailstr.app')
    expect(
      deriveFromAddress({ ...base, senderAddress: `${NPUB}@mailstr.app` }),
    ).toBe('alice@mailstr.app')
    expect(
      deriveFromAddress({ ...base, preferredFrom: `${NPUB}@mailstr.app` }),
    ).toBe('alice@mailstr.app')
  })

  it('falls back to the saved sender address', () => {
    expect(deriveFromAddress({ ...base, senderAddress: 'bob@mailstr.app' })).toBe(
      'bob@mailstr.app',
    )
  })

  it('ends with the first sendable self address when nothing else is available', () => {
    expect(
      deriveFromAddress({ ...base, ownedAliases: [], selfAddresses: ['solo@mailstr.app'] }),
    ).toBe('solo@mailstr.app')
  })

  it('returns empty when the only address is the npub', () => {
    expect(
      deriveFromAddress({
        ...base,
        ownedAliases: [],
        selfAddresses: [`${NPUB}@mailstr.app`],
      }),
    ).toBe('')
    expect(
      deriveFromAddress({ ...base, ownedAliases: [], selfAddresses: [] }),
    ).toBe('')
  })
})

describe('deriveFromOptions', () => {
  it('leads with the selected sender, dropping its duplicate', () => {
    expect(
      deriveFromOptions(['bob@mailstr.app', 'alice@mailstr.app'], 'alice@mailstr.app'),
    ).toEqual(['alice@mailstr.app', 'bob@mailstr.app'])
  })

  it('filters the npub out of the options', () => {
    expect(
      deriveFromOptions([`${NPUB}@mailstr.app`, 'alice@mailstr.app'], 'alice@mailstr.app'),
    ).toEqual(['alice@mailstr.app'])
  })

  it('returns only the rest when the From is empty', () => {
    expect(deriveFromOptions(['a@x.com', 'b@y.com'], '')).toEqual(['a@x.com', 'b@y.com'])
  })
})

describe('hasKnownLegacyRecipient', () => {
  const localDomains = ['mailstr.app']

  it('fires for a known legacy domain outside the local set', () => {
    expect(hasKnownLegacyRecipient(['bob@gmail.com'], localDomains)).toBe(true)
  })

  it('does not fire for local or nostr-native domains', () => {
    expect(hasKnownLegacyRecipient(['alice@mailstr.app'], localDomains)).toBe(false)
    expect(hasKnownLegacyRecipient(['bob@npub.pro'], localDomains)).toBe(false)
  })

  it('does not fire for unknown domains or non-address shapes', () => {
    expect(hasKnownLegacyRecipient(['bob@unknown-domain.example'], localDomains)).toBe(false)
    expect(hasKnownLegacyRecipient([NPUB], localDomains)).toBe(false)
  })
})

describe('isNpubSender', () => {
  it('detects an npub localpart', () => {
    expect(isNpubSender(`${NPUB}@mailstr.app`)).toBe(true)
    expect(isNpubSender('alice@mailstr.app')).toBe(false)
  })
})