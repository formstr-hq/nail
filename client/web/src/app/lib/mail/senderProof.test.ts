import { describe, it, expect } from 'vitest'
import { nip19 } from 'nostr-tools'
import {
  deriveSenderProof,
  displaySender,
  effectiveSender,
  isProven,
  showsSigningKey,
} from './senderProof'
import type { BridgeProbe } from '@/app/lib/nostr/bridge'
import type { Nip05State } from '@/app/lib/nostr/nip05'

const SEAL = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const OWN = 'c'.repeat(64)
const BRIDGE = 'd'.repeat(64)

const resolved = (pubkey: string): BridgeProbe => ({
  target: '_smtp@mailstr.app',
  label: 'mailstr.app',
  isDefault: true,
  status: 'resolved',
  pubkey,
})
const resolving = (): BridgeProbe => ({
  target: '_smtp@mailstr.app',
  label: 'mailstr.app',
  isDefault: true,
  status: 'resolving',
})
const failed = (): BridgeProbe => ({
  target: '_smtp@mailstr.app',
  label: 'mailstr.app',
  isDefault: true,
  status: 'failed',
  message: 'did not answer',
})

const header = { name: 'Jack', address: 'jack@example.org' }
const noNip05: Nip05State = { status: 'resolved', pubkey: null }

function derive(over: Partial<Parameters<typeof deriveSenderProof>[0]> = {}) {
  return deriveSenderProof({
    fromHeader: header,
    sealPubkey: SEAL,
    ownPubkey: null,
    bridges: [resolved(BRIDGE)],
    nip05: noNip05,
    ...over,
  })
}

describe('deriveSenderProof', () => {
  it('trusts the header when a RESOLVED bridge sealed it', () => {
    expect(derive({ sealPubkey: BRIDGE })).toBe('bridge-seal')
  })

  it('trusts a bridge that is not the outbound one (multi-bridge)', () => {
    const second: BridgeProbe = {
      target: '_smtp@other.example',
      label: 'other.example',
      isDefault: false,
      status: 'resolved',
      pubkey: OTHER,
    }
    expect(derive({ sealPubkey: OTHER, bridges: [resolved(BRIDGE), second] })).toBe('bridge-seal')
  })

  it('marks our own outgoing copy as self-sealed', () => {
    expect(derive({ sealPubkey: OWN, ownPubkey: OWN })).toBe('own-seal')
  })

  it("accepts the header when the address's NIP-05 resolves to the sealing key", () => {
    expect(
      derive({ sealPubkey: OTHER, nip05: { status: 'resolved', pubkey: OTHER } }),
    ).toBe('nip05')
  })

  it('is `checking`, not `none`, while a bridge is still resolving', () => {
    expect(derive({ sealPubkey: OTHER, bridges: [resolving()], ownPubkey: OWN })).toBe('checking')
  })

  it('is `checking` while the address NIP-05 probe is in flight', () => {
    expect(derive({ sealPubkey: OTHER, nip05: { status: 'resolving' } })).toBe('checking')
  })

  // The regression this whole change exists for: a message decoded before the
  // bridge resolved must flip to bridge-seal when it lands, NOT stay `none`.
  it('flips from checking to bridge-seal as the bridge resolves (no cached verdict)', () => {
    expect(derive({ sealPubkey: BRIDGE, bridges: [resolving()] })).toBe('checking')
    expect(derive({ sealPubkey: BRIDGE, bridges: [resolved(BRIDGE)] })).toBe('bridge-seal')
  })

  it('says `bridge-unavailable` (not `none`) when every bridge failed', () => {
    expect(derive({ sealPubkey: OTHER, bridges: [failed()] })).toBe('bridge-unavailable')
  })

  it('is `checking`, not `bridge-unavailable`, while any bridge is still resolving', () => {
    const secondResolving: BridgeProbe = {
      target: '_smtp@other.example',
      label: 'other.example',
      isDefault: false,
      status: 'resolving',
    }
    const secondFailed: BridgeProbe = {
      target: '_smtp@other.example',
      label: 'other.example',
      isDefault: false,
      status: 'failed',
      message: 'no',
    }
    // One failed but another still going: could still prove the sender.
    expect(derive({ sealPubkey: OTHER, bridges: [failed(), secondResolving] })).toBe('checking')
    // Every bridge settled failed: our resolver failed, say so.
    expect(derive({ sealPubkey: OTHER, bridges: [failed(), secondFailed] })).toBe(
      'bridge-unavailable',
    )
  })

  it('is `checking` before the first probe pass has even started (empty bridge list)', () => {
    expect(derive({ sealPubkey: OTHER, bridges: [] })).toBe('checking')
  })

  it('falls back to `none` when every check settled with no proof', () => {
    expect(derive({ sealPubkey: OTHER, bridges: [resolved(BRIDGE)] })).toBe('none')
  })

  it('never trusts a header with no address-shaped claim', () => {
    expect(derive({ fromHeader: { address: '' }, bridges: [resolved(BRIDGE)] })).toBe('none')
    // A bare npub From on OUR OWN copy: recognised as ours because the seal is
    // ours, not because the npub is address-shaped.
    expect(
      derive({
        fromHeader: { address: nip19.npubEncode(OWN) },
        sealPubkey: OWN,
        bridges: [resolved(BRIDGE)],
        ownPubkey: OWN,
      }),
    ).toBe('own-seal')
    // A bare npub header from someone else is not a claim: even with no proof
    // it is `none` immediately rather than holding on a NIP-05 check that
    // cannot exist.
    expect(
      derive({
        fromHeader: { address: nip19.npubEncode(SEAL) },
        sealPubkey: OTHER,
        bridges: [resolving()],
        nip05: { status: 'skipped' },
      }),
    ).toBe('none')
  })
})

describe('displaySender', () => {
  it('shows the header when the proof backs it (including while checking)', () => {
    for (const proof of ['bridge-seal', 'nip05', 'own-seal', 'checking'] as const) {
      expect(displaySender(proof, { fromHeader: header, sealPubkey: SEAL }).address).toBe(
        'jack@example.org',
      )
    }
  })

  it('shows the npub, labelled by the kind-0 name, when nothing backs the header', () => {
    const from = displaySender('none', {
      fromHeader: header,
      sealPubkey: SEAL,
      profileName: 'Your Bank',
    })
    expect(from.address).toBe(nip19.npubEncode(SEAL))
    expect(from.name).toBe('Your Bank')
  })

  it('shows the key for bridge-unavailable too', () => {
    expect(
      displaySender('bridge-unavailable', { fromHeader: header, sealPubkey: SEAL }).address,
    ).toBe(nip19.npubEncode(SEAL))
  })
})

describe('proof classifiers', () => {
  it('isProven is true only for the three backed verdicts', () => {
    expect(isProven('bridge-seal')).toBe(true)
    expect(isProven('nip05')).toBe(true)
    expect(isProven('own-seal')).toBe(true)
    expect(isProven('checking')).toBe(false)
    expect(isProven('bridge-unavailable')).toBe(false)
    expect(isProven('none')).toBe(false)
  })

  it('showsSigningKey is false for checking (the header is rendered)', () => {
    expect(showsSigningKey('checking')).toBe(false)
    expect(showsSigningKey('bridge-unavailable')).toBe(true)
    expect(showsSigningKey('none')).toBe(true)
  })
})

describe('effectiveSender (non-React consumers)', () => {
  // Side-effecting surfaces (contacts, alias filing) must never act on a claim
  // nothing backs yet — unlike the rendered UI, which shows the header while
  // marked "checking".
  it('falls back to the key while a check is unsettled', () => {
    const from = effectiveSender(
      { fromHeader: header, senderPubkey: SEAL },
      { ownPubkey: null, bridges: [resolving()], nip05: { 'jack@example.org': { status: 'resolving' } } },
    )
    expect(from.address).toBe(nip19.npubEncode(SEAL))
  })

  it('uses the header once a bridge proof lands', () => {
    const from = effectiveSender(
      { fromHeader: header, senderPubkey: BRIDGE },
      { ownPubkey: null, bridges: [resolved(BRIDGE)], nip05: {} },
    )
    expect(from.address).toBe('jack@example.org')
  })

  it('uses the key (not the header) when nothing backs it', () => {
    const from = effectiveSender(
      { fromHeader: header, senderPubkey: OTHER },
      { ownPubkey: null, bridges: [resolved(BRIDGE)], nip05: {} },
    )
    expect(from.address).toBe(nip19.npubEncode(OTHER))
  })
})
