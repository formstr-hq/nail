import { find } from 'linkifyjs'

/**
 * The plaintext body split into plain runs and clickable URLs.
 *
 * Plaintext mail renders in a `<pre>` (whitespace is meaningful), so URLs are
 * inert text unless we find them ourselves. `linkifyjs` does the finding —
 * hand-rolling URL detection is exactly the kind of core parsing AGENTS rule
 * 13 says to take from a proven library.
 *
 * Only `url` tokens are linkified. Email addresses are deliberately not: an
 * `mailto:` link would open the OS mail client (a foreign app) from inside
 * the reader, and every address is already actionable via Reply.
 */
export type PlainSegment = { text: string; href?: string }

export function splitPlainLinks(text: string): PlainSegment[] {
  const segments: PlainSegment[] = []
  let cursor = 0
  for (const token of find(text, 'url')) {
    if (token.start > cursor) segments.push({ text: text.slice(cursor, token.start) })
    segments.push({ text: token.value, href: token.href })
    cursor = token.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}
