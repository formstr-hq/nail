import { describe, it, expect } from 'vitest'
import { nip19 } from 'nostr-tools'
import { buildSteps, decodePubkey, DNS_HELP, DNS_ORDER, MAIL_RECORD_KEYS } from './workspaceUi'

/**
 * The workspace page's pure logic. These pin the two things that break
 * silently: the npub/hex decode (an admin pasting the wrong form) and the
 * setup-progress derivation (a step shown as done when it is not).
 */

const HEX = 'a'.repeat(64)
const NPUB = nip19.npubEncode(HEX)

describe('decodePubkey', () => {
  it('passes through a 64-char hex key, lowercased', () => {
    expect(decodePubkey(HEX.toUpperCase())).toBe(HEX)
  })

  it('decodes an npub to hex — the form a nostr client shows', () => {
    expect(decodePubkey(NPUB)).toBe(HEX)
  })

  it('tolerates surrounding whitespace', () => {
    expect(decodePubkey(`  ${NPUB}  `)).toBe(HEX)
  })

  it('returns null for junk, a short key, or an nsec', () => {
    expect(decodePubkey('not-a-key')).toBeNull()
    expect(decodePubkey('abc123')).toBeNull()
    expect(decodePubkey(nip19.nsecEncode(new Uint8Array(32).fill(1)))).toBeNull()
  })
})

describe('buildSteps', () => {
  it('marks DNS publish as the current step before verification', () => {
    const steps = buildSteps({ active: false, seatsUsed: 0 })
    expect(steps.find((s) => s.id === 'dns')?.state).toBe('current')
    expect(steps.find((s) => s.id === 'verify')?.state).toBe('todo')
    expect(steps.find((s) => s.id === 'addresses')?.state).toBe('todo')
    expect(steps.find((s) => s.id === 'add')?.state).toBe('done')
  })

  it('moves the current step to addresses once verified but empty', () => {
    const steps = buildSteps({ active: true, seatsUsed: 0 })
    expect(steps.find((s) => s.id === 'dns')?.state).toBe('done')
    expect(steps.find((s) => s.id === 'verify')?.state).toBe('done')
    expect(steps.find((s) => s.id === 'addresses')?.state).toBe('current')
    expect(steps.find((s) => s.id === 'send')?.state).toBe('todo')
  })

  it('marks everything done once verified with an address', () => {
    const steps = buildSteps({ active: true, seatsUsed: 2 })
    expect(steps.every((s) => s.state === 'done')).toBe(true)
  })
})

describe('DNS metadata', () => {
  it('has help copy for every record, in a defined order', () => {
    for (const key of DNS_ORDER) {
      expect(DNS_HELP[key]).toBeTruthy()
      expect(DNS_HELP[key].why.length).toBeGreaterThan(0)
    }
    // The order leads with verification, then the mail records.
    expect(DNS_ORDER[0]).toBe('verify')
    expect(DNS_ORDER.slice(1)).toEqual(MAIL_RECORD_KEYS)
  })

  it('states the DMARC policy rejects fake mail, matching the backend', () => {
    expect(DNS_HELP.dmarc.why).toMatch(/reject/i)
  })
})
