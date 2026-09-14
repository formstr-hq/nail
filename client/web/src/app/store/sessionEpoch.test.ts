import { describe, expect, it } from 'vitest'
import { bumpSessionEpoch, isCurrentSession, sessionEpoch } from './sessionEpoch'

describe('sessionEpoch', () => {
  it('invalidates work captured before a bump', () => {
    const before = sessionEpoch()
    expect(isCurrentSession(before)).toBe(true)

    const after = bumpSessionEpoch()
    expect(after).toBeGreaterThan(before)
    expect(isCurrentSession(before)).toBe(false)
    expect(isCurrentSession(after)).toBe(true)
  })

  it('keeps validating work captured after the bump', () => {
    bumpSessionEpoch()
    const captured = sessionEpoch()
    expect(isCurrentSession(captured)).toBe(true)
  })
})
