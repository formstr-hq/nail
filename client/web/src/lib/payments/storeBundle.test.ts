import { describe, it, expect } from 'vitest'
import { ALLOWLIST, DENYLIST, findHits, nativeProblems } from '../../../../scripts/check-store-bundle.mjs'

/**
 * The post-build guard that fails a store build containing Lightning or card
 * code. Its real run is `pnpm --filter mailstr-client check:store` on an actual
 * store bundle; these pin what it does and does not flag.
 */
describe('check-store-bundle', () => {
  it('flags every denylisted rail, case-insensitively', () => {
    for (const term of ['Lightning', 'lnbc1pxyz', 'WebLN', 'js.stripe.com', '/api/generate-invoice/mail', '/ws?hash=abc']) {
      expect(findHits(`before ${term} after`, 'a.js').length, term).toBeGreaterThan(0)
    }
  })

  it('passes ordinary app code', () => {
    expect(findHits('const price = store.get(id).getOffer()', 'a.js')).toEqual([])
  })

  it('ignores only the documented library internals', () => {
    // nostr-tools' kind-name table is allowlisted ...
    expect(findHits('{LightningPubRPC:1,NutZap:2,Zap:3,ZapGoal:4}', 'a.js')).toEqual([])
    // ... but app copy that merely resembles it is not.
    expect(findHits('Pay once with Lightning', 'a.js').length).toBeGreaterThan(0)
    expect(findHits('"zap" payment', 'a.js').length).toBeGreaterThan(0)
  })

  it('every allowlist entry carries a written reason', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0)
    for (const entry of ALLOWLIST) expect(entry.why.length).toBeGreaterThan(20)
    expect(DENYLIST).toContain('stripe')
  })

  it('knows when the native project is out of step', () => {
    // No Android project at an unknown root: nothing to check.
    expect(nativeProblems('open', '/nonexistent')).toEqual([])
  })
})
