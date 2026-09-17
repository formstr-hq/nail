import { describe, it, expect } from 'vitest'
import { inboxFilters } from './inboxFilter'

const ROLLOUT = Math.floor(Date.UTC(2026, 7, 18) / 1000)

describe('inboxFilters', () => {
  const PK = 'a'.repeat(64)

  it('partitions the mailbox into tagged, pre-tag, and post-tag queries', () => {
    expect(inboxFilters(PK)).toEqual([
      { kinds: [1059], '#p': [PK], '#k': ['1301'] },
      { kinds: [1059], '#p': [PK], until: ROLLOUT },
      { kinds: [1059], '#p': [PK], since: ROLLOUT },
    ])
  })

  // The regression this fixes: `#k`-only silently drops every pre-tag wrap, and
  // a tag cannot be backfilled (the id commits to it) — so a window below the
  // rollout, with NO `#k`, is the only way to reach that history.
  it('reaches pre-tag mail via an untagged window bounded above the rollout', () => {
    const preTag = inboxFilters(PK).find((f) => f.until !== undefined)!
    expect(preTag).toBeDefined()
    expect(preTag['#k']).toBeUndefined()
    expect(preTag.until).toBe(ROLLOUT)
    expect(preTag.since).toBeUndefined()
  })

  // The other half: a DM-heavy account. The tagged query stays unwindowed so
  // mail has a path independent of how many DMs a relay's capped window holds.
  it('keeps a whole-history tagged query scoped to the mail inner-kind', () => {
    const tagged = inboxFilters(PK).find((f) => f['#k'] !== undefined)!
    expect(tagged['#k']).toEqual(['1301'])
    expect(tagged['#p']).toEqual([PK])
    expect(tagged.since).toBeUndefined()
    expect(tagged.until).toBeUndefined()
  })

  // Post-rollout untagged mail (a non-conforming third-party sender) is only
  // visible to a `#p`-only window above the rollout.
  it('covers post-rollout untagged mail with a bounded-from query', () => {
    const postTag = inboxFilters(PK).find(
      (f) => f.until === undefined && f['#k'] === undefined,
    )!
    expect(postTag['#p']).toEqual([PK])
    expect(postTag.since).toBe(ROLLOUT)
  })
})
