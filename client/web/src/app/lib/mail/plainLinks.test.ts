import { describe, expect, it } from 'vitest'
import { splitPlainLinks } from './plainLinks'

describe('splitPlainLinks', () => {
  it('returns the whole text as one plain segment when no URL is present', () => {
    expect(splitPlainLinks('nothing to see here')).toEqual([
      { text: 'nothing to see here' },
    ])
  })

  it('splits a URL out of the surrounding prose, preserving both sides', () => {
    expect(splitPlainLinks('see https://example.org/plain now')).toEqual([
      { text: 'see ' },
      { text: 'https://example.org/plain', href: 'https://example.org/plain' },
      { text: ' now' },
    ])
  })

  it('links every URL across lines and blank lines', () => {
    const segments = splitPlainLinks(
      'one https://a.example/x\ntwo\n\nhttps://b.example/y end',
    )
    expect(segments.filter((s) => s.href).map((s) => s.href)).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ])
    expect(segments.map((s) => s.text).join('')).toBe(
      'one https://a.example/x\ntwo\n\nhttps://b.example/y end',
    )
  })

  it('infers a scheme for a bare www host', () => {
    expect(splitPlainLinks('go to www.example.com')).toEqual([
      { text: 'go to ' },
      { text: 'www.example.com', href: 'http://www.example.com' },
    ])
  })

  it('does not linkify email addresses', () => {
    // A mailto: link would launch a foreign app from the reader; addresses
    // are actionable through Reply instead.
    expect(splitPlainLinks('write to a@b.com')).toEqual([{ text: 'write to a@b.com' }])
  })

  it('never loses or reorders any text', () => {
    const text = 'a http://x.io/1 b https://y.io/2 c'
    expect(splitPlainLinks(text).map((s) => s.text).join('')).toBe(text)
  })
})
