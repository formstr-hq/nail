import { describe, expect, it } from 'vitest'
import {
  splitRecipients,
  signatureBlock,
  parseRecipients,
  defaultNpubAddress,
  deriveFromAddress,
  deriveFromOptions,
  hasKnownLegacyRecipient,
  isNpubSender,
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
})

describe('defaultNpubAddress', () => {
  it('wraps the npub in the bridge domain', () => {
    expect(defaultNpubAddress(NPUB)).toBe(`${NPUB}@mailstr.app`)
  })

  it('is empty when signed out', () => {
    expect(defaultNpubAddress(undefined)).toBe('')
  })
})

describe('deriveFromAddress', () => {
  const base = {
    inboxFilter: '',
    selfAddresses: [`${NPUB}@mailstr.app`, 'alice@mailstr.app'],
    senderAddress: undefined as string | undefined,
    ownedAliases: ['alice@mailstr.app'],
    defaultAddress: `${NPUB}@mailstr.app`,
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

  it('falls back to the saved sender address', () => {
    expect(deriveFromAddress({ ...base, senderAddress: `${NPUB}@mailstr.app` })).toBe(
      `${NPUB}@mailstr.app`,
    )
  })

  it('then to the first owned alias, then the npub default', () => {
    expect(deriveFromAddress({ ...base, ownedAliases: [] })).toBe(`${NPUB}@mailstr.app`)
    expect(
      deriveFromAddress({ ...base, ownedAliases: [], defaultAddress: '' }),
    ).toBe(`${NPUB}@mailstr.app`)
  })

  it('ends with the first self address when nothing else is available', () => {
    expect(
      deriveFromAddress({ ...base, ownedAliases: [], defaultAddress: '', selfAddresses: ['solo@mailstr.app'] }),
    ).toBe('solo@mailstr.app')
    expect(
      deriveFromAddress({
        ...base,
        ownedAliases: [],
        defaultAddress: '',
        selfAddresses: [],
      }),
    ).toBe('')
  })
})

describe('deriveFromOptions', () => {
  it('leads with the selected sender, dropping its duplicate', () => {
    expect(
      deriveFromOptions([`${NPUB}@mailstr.app`, 'alice@mailstr.app'], 'alice@mailstr.app'),
    ).toEqual(['alice@mailstr.app', `${NPUB}@mailstr.app`])
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