import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nip19 } from 'nostr-tools'
import { resolveRecipients } from './resolve'
import { clearProbeCache } from '@/lib/nostr/nip05'

const ALICE = 'a'.repeat(64)
const BRIDGE = 'c'.repeat(64)
const CTX = { localDomains: ['mailstr.app'], ownDomain: 'mailstr.app', bridgePubkey: BRIDGE }

function mockNames(names: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ names }))))
}

beforeEach(() => clearProbeCache())
afterEach(() => vi.unstubAllGlobals())

describe('resolveRecipients', () => {
  it('sends mailstr-to-mailstr direct, never via the bridge', async () => {
    mockNames({ alice: ALICE })
    const out = await resolveRecipients(['alice@mailstr.app'], CTX)
    expect(out.nostr).toEqual([{ pubkey: ALICE, headerAddress: 'alice@mailstr.app' }])
    expect(out.legacy).toEqual([])
  })

  it('routes an unknown external domain to the bridge', async () => {
    mockNames({})
    const out = await resolveRecipients(['bob@example.org'], CTX)
    expect(out.legacy).toEqual(['bob@example.org'])
    expect(out.nostr).toEqual([])
  })

  // The client already knows this address cannot exist; handing it to the
  // bridge would only earn a slow Postfix bounce.
  it('errors on an unregistered local name instead of routing to the bridge', async () => {
    mockNames({})
    const out = await resolveRecipients(['ghost@mailstr.app'], CTX)
    expect(out.legacy).toEqual([])
    expect(out.errors[0]).toContain('ghost@mailstr.app')
  })

  it('accepts a bare npub and writes an addressable header', async () => {
    const npub = nip19.npubEncode('d'.repeat(64))
    const out = await resolveRecipients([npub], CTX)
    expect(out.nostr).toHaveLength(1)
    expect(out.nostr[0].headerAddress).toBe(`${npub}@mailstr.app`)
  })

  // Replying to a Nostr-native sender must go direct, not detour through the
  // bridge as legacy mail.
  it('resolves <npub>@domain straight back to the pubkey', async () => {
    const hex = 'd'.repeat(64)
    const npub = nip19.npubEncode(hex)
    const out = await resolveRecipients([`${npub}@mailstr.app`], CTX)
    expect(out.nostr[0].pubkey).toBe(hex)
    expect(out.legacy).toEqual([])
  })

  it('errors for legacy recipients when no bridge is configured', async () => {
    mockNames({})
    const out = await resolveRecipients(['bob@example.org'], { ...CTX, bridgePubkey: null })
    expect(out.errors[0]).toMatch(/bridge/i)
  })

  it('probes each address only once', async () => {
    const f = vi.fn(() => new Response(JSON.stringify({ names: {} })))
    vi.stubGlobal('fetch', f)
    await resolveRecipients(['a@example.org'], CTX)
    await resolveRecipients(['a@example.org'], CTX)
    expect(f).toHaveBeenCalledTimes(1)
  })

  // Seeded negative cache: the common case costs no network call at all.
  it('never probes the big legacy providers', async () => {
    const f = vi.fn(() => new Response(JSON.stringify({ names: {} })))
    vi.stubGlobal('fetch', f)
    const out = await resolveRecipients(['bob@gmail.com'], CTX)
    expect(f).not.toHaveBeenCalled()
    expect(out.legacy).toEqual(['bob@gmail.com'])
  })

  // Fail-safe, not fail-open: a hung probe must not hang the compose window.
  it('treats a probe failure as legacy rather than erroring', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('timeout'))))
    const out = await resolveRecipients(['bob@example.org'], CTX)
    expect(out.legacy).toEqual(['bob@example.org'])
    expect(out.errors).toEqual([])
  })
})
