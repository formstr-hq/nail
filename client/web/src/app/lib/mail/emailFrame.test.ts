import { describe, expect, it } from 'vitest'
import { buildEmailFrame, hasRemoteContent } from './emailFrame'

describe('buildEmailFrame', () => {
  it('renders dark-mode mail on a white sheet so author colours stay readable', () => {
    // The bug: HTML mail authored for a white page bakes in dark ink/links,
    // which vanish on a dark, transparent surface. Dark mode must give it the
    // white sheet it expects.
    const doc = buildEmailFrame('<p>hi</p>', false, true)
    expect(doc).toContain('background:#ffffff')
    expect(doc).toContain('color-scheme:light')
    expect(doc).not.toContain('background:transparent')
  })

  it('stays transparent in light mode, inheriting the reading pane', () => {
    const doc = buildEmailFrame('<p>hi</p>', false, false)
    expect(doc).toContain('background:transparent')
    expect(doc).toContain('padding:0')
  })

  it('gives links a colour of their own, not the body ink', () => {
    // Regression: links used to inherit the body colour, so a message that set
    // its own dark link colour was indistinguishable — and unreadable on dark.
    const doc = buildEmailFrame('<a href="#">x</a>', false, true)
    expect(doc).toMatch(/a\{color:#[0-9a-f]{6}\}/)
    expect(doc).not.toMatch(/a\{color:#111111\}/)
  })

  it('blocks remote images until asked, then allows them', () => {
    expect(buildEmailFrame('', false, true)).toContain('img-src data:')
    expect(buildEmailFrame('', false, true)).not.toContain('img-src data: https:')
    expect(buildEmailFrame('', true, true)).toContain('img-src data: https: http:')
  })
})

describe('hasRemoteContent', () => {
  it('detects http(s) image sources', () => {
    expect(hasRemoteContent('<img src="https://x/y.png">')).toBe(true)
    expect(hasRemoteContent('<img src="data:image/png;base64,AAAA">')).toBe(false)
    expect(hasRemoteContent('<p>no images</p>')).toBe(false)
  })
})
