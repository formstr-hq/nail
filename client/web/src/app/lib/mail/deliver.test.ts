import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Event } from 'nostr-tools'

// Hermetic: no worker, no sockets, no signer timeouts. The discovery/API
// module is mocked at its boundary so these tests pin the ROUTING rule
// (API-first for bridge wraps, relay for the rest, relay fallback on failure).
const fetchMailDiscovery = vi.fn<(...a: unknown[]) => Promise<unknown>>()
const sendWrapViaApi = vi.fn<(...a: unknown[]) => Promise<unknown>>()
vi.mock('@/app/lib/nostr/bridgeSend', () => ({
  fetchMailDiscovery: (...a: unknown[]) => fetchMailDiscovery(...a),
  sendWrapViaApi: (...a: unknown[]) => sendWrapViaApi(...a),
}))

const publish =
  vi.fn<(...a: unknown[]) => Promise<{ status: string; relay: string; message?: string }[]>>()
vi.mock('@/app/lib/nostr/localRelay', () => ({
  getLocalRelay: () => ({ publish: (...a: unknown[]) => publish(...a) }),
}))
const dmRelays = vi.fn<(...a: unknown[]) => Promise<string[]>>()
vi.mock('@/app/lib/nostr/relays', () => ({
  fetchDmRelays: (...a: unknown[]) => dmRelays(...a),
}))
vi.mock('@/app/lib/nostr/signer', () => ({
  withSignerTimeout: (_label: string, fn: () => unknown) => fn(),
}))

import { deliverWraps } from './deliver'

const BRIDGE = 'b'.repeat(64)
const BOB = 'c'.repeat(64)
const ME = 'd'.repeat(64)
const active = { signEvent: vi.fn() }
const discovery = { bridgePubkey: BRIDGE, sendWrapEndpoint: 'https://api/mails/send-wrap' }

function wrap(ptag: string): Event {
  return { id: ptag, kind: 1059, pubkey: 'e', sig: 's', content: '', created_at: 0, tags: [['p', ptag]] } as Event
}

beforeEach(() => {
  fetchMailDiscovery.mockReset()
  sendWrapViaApi.mockReset()
  publish.mockReset()
  dmRelays.mockReset()
  fetchMailDiscovery.mockResolvedValue(discovery)
  sendWrapViaApi.mockResolvedValue({ ok: true, status: 202 })
  dmRelays.mockResolvedValue(['wss://relay.example'])
  publish.mockResolvedValue([{ status: 'accepted', relay: 'wss://relay.example' }])
})

describe('deliverWraps', () => {
  it('routes bridge wraps through the API and never publishes them to relays', async () => {
    const result = await deliverWraps({
      wraps: [wrap(BRIDGE)],
      targets: [BRIDGE],
      senderPubkey: ME,
      bridgePubkey: BRIDGE,
      bridgeDomain: 'mailstr.app',
      active: active as never,
    })

    expect(result).toEqual({ viaApi: 1, viaRelay: 0 })
    expect(sendWrapViaApi).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
  })

  it('publishes Nostr-direct wraps and the self-copy to relays, not the API', async () => {
    const result = await deliverWraps({
      wraps: [wrap(BOB), wrap(ME)],
      targets: [BOB, ME],
      senderPubkey: ME,
      bridgePubkey: BRIDGE,
      bridgeDomain: 'mailstr.app',
      active: active as never,
    })

    expect(result).toEqual({ viaApi: 0, viaRelay: 2 })
    expect(sendWrapViaApi).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('falls back to relay for a bridge wrap the API declines', async () => {
    sendWrapViaApi.mockResolvedValue({ ok: false, status: 502, reason: 'Bridge unavailable' })

    const result = await deliverWraps({
      wraps: [wrap(BRIDGE)],
      targets: [BRIDGE],
      senderPubkey: ME,
      bridgePubkey: BRIDGE,
      bridgeDomain: 'mailstr.app',
      active: active as never,
    })

    expect(result).toEqual({ viaApi: 0, viaRelay: 1 })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('falls back to relay when discovery names a different bridge', async () => {
    fetchMailDiscovery.mockResolvedValue({ ...discovery, bridgePubkey: 'f'.repeat(64) })

    const result = await deliverWraps({
      wraps: [wrap(BRIDGE)],
      targets: [BRIDGE],
      senderPubkey: ME,
      bridgePubkey: BRIDGE,
      bridgeDomain: 'mailstr.app',
      active: active as never,
    })

    expect(result).toEqual({ viaApi: 0, viaRelay: 1 })
    expect(sendWrapViaApi).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('falls back to relay when discovery is unavailable', async () => {
    fetchMailDiscovery.mockResolvedValue(null)

    const result = await deliverWraps({
      wraps: [wrap(BRIDGE)],
      targets: [BRIDGE],
      senderPubkey: ME,
      bridgePubkey: BRIDGE,
      bridgeDomain: 'mailstr.app',
      active: active as never,
    })

    expect(result).toEqual({ viaApi: 0, viaRelay: 1 })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('throws when a real recipient is undeliverable by API and relay', async () => {
    fetchMailDiscovery.mockResolvedValue(null)
    publish.mockResolvedValue([{ status: 'rejected', relay: 'wss://relay.example', message: 'blocked' }])

    await expect(
      deliverWraps({
        wraps: [wrap(BRIDGE)],
        targets: [BRIDGE],
        senderPubkey: ME,
        bridgePubkey: BRIDGE,
        bridgeDomain: 'mailstr.app',
        active: active as never,
      }),
    ).rejects.toThrow(/Could not deliver to/)
  })

  it('does not throw when only the self-copy fails to relay', async () => {
    publish.mockResolvedValue([{ status: 'rejected', relay: 'wss://relay.example', message: 'blocked' }])

    const result = await deliverWraps({
      wraps: [wrap(ME)],
      targets: [ME],
      senderPubkey: ME,
      bridgePubkey: BRIDGE,
      bridgeDomain: 'mailstr.app',
      active: active as never,
    })

    expect(result).toEqual({ viaApi: 0, viaRelay: 1 })
  })
})
