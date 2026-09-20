import { describe, it, expect } from 'vitest'
import { defaultPrunePolicy } from '@formstr/local-relay'
import { mailPrunePolicy } from './prunePolicy'
import { KIND_GIFTWRAP, KIND_MAIL_META, KIND_SETTINGS } from './constants'

/**
 * Regression: the package default does not protect kind-1059 gift wraps, so the
 * local relay ages the cached mailbox out at 7 days (and evicts it under the
 * 50k cap). These tests pin the guarantee that mail kinds survive both.
 */
describe('mailPrunePolicy', () => {
  it('protects the mail, metadata, and settings kinds the package default does not', () => {
    const base = defaultPrunePolicy()
    // Guard the premise: if upstream ever protects these, this override is
    // redundant and this test should be removed rather than silently kept.
    expect(base.protectedKinds.has(KIND_GIFTWRAP)).toBe(false)
    expect(base.protectedKinds.has(KIND_MAIL_META)).toBe(false)
    expect(base.protectedKinds.has(KIND_SETTINGS)).toBe(false)

    const policy = mailPrunePolicy()
    expect(policy.protectedKinds.has(KIND_GIFTWRAP)).toBe(true)
    expect(policy.protectedKinds.has(KIND_MAIL_META)).toBe(true)
    expect(policy.protectedKinds.has(KIND_SETTINGS)).toBe(true)
  })

  it('keeps every kind the package default already protected', () => {
    const base = defaultPrunePolicy()
    const policy = mailPrunePolicy()
    for (const kind of base.protectedKinds) {
      expect(policy.protectedKinds.has(kind)).toBe(true)
    }
  })

  it('does not otherwise change the default policy (TTLs, cap)', () => {
    const base = defaultPrunePolicy()
    const policy = mailPrunePolicy()
    expect(policy.defaultTtlSeconds).toBe(base.defaultTtlSeconds)
    expect(policy.maxEvents).toBe(base.maxEvents)
    expect([...policy.ttlByKind.entries()]).toEqual([...base.ttlByKind.entries()])
  })
})
