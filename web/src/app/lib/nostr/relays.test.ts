import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Event } from 'nostr-tools'
import { KIND_DM_RELAYS, DEFAULT_RELAYS } from './constants'

// Mock the worker-backed relay so these stay hermetic — no IndexedDB, no sockets.
const queryLocal = vi.fn<(...a: unknown[]) => Promise<Event[]>>()
const publish = vi.fn<(...a: unknown[]) => Promise<{ status: string; relay: string; message?: string }[]>>()
vi.mock('./localRelay', () => ({
  queryLocal: (...a: unknown[]) => queryLocal(...a),
  getLocalRelay: () => ({ publish: (...a: unknown[]) => publish(...a) }),
}))
// withSignerTimeout just runs the thunk in these tests.
vi.mock('./signer', () => ({
  withSignerTimeout: (_label: string, fn: () => unknown) => fn(),
}))

import {
  fetchDmRelayList,
  publishDmRelays,
  fetchDmRelays,
  clearDmRelayCache,
} from './relays'

const PUBKEY = 'a'.repeat(64)

function relayListEvent(relays: string[], created_at = 1000): Event {
  return {
    kind: KIND_DM_RELAYS,
    created_at,
    tags: relays.map((r) => ['relay', r]),
    content: '',
    pubkey: PUBKEY,
    id: 'id',
    sig: 'sig',
  } as Event
}

beforeEach(() => {
  queryLocal.mockReset()
  publish.mockReset()
  clearDmRelayCache()
})

describe('fetchDmRelayList', () => {
  it('reports no list and returns the defaults when nothing is published', async () => {
    queryLocal.mockResolvedValue([])
    const res = await fetchDmRelayList(PUBKEY)
    expect(res).toEqual({ relays: DEFAULT_RELAYS, hasList: false })
  })

  it('reports an existing list and returns its relays', async () => {
    const relays = ['wss://one.example', 'wss://two.example']
    queryLocal.mockResolvedValue([relayListEvent(relays)])
    const res = await fetchDmRelayList(PUBKEY)
    expect(res).toEqual({ relays, hasList: true })
  })

  it('treats an empty relay-tag list as no list', async () => {
    queryLocal.mockResolvedValue([relayListEvent([])])
    const res = await fetchDmRelayList(PUBKEY)
    expect(res.hasList).toBe(false)
    expect(res.relays).toEqual(DEFAULT_RELAYS)
  })
})

describe('publishDmRelays', () => {
  const active = {
    signEvent: vi.fn(async (t: unknown) => ({ ...(t as object), id: 'signed', sig: 'sig' })),
  } as never

  beforeEach(() => {
    ;(active as unknown as { signEvent: ReturnType<typeof vi.fn> }).signEvent.mockClear()
  })

  it('signs a kind-10050 event with a relay tag per URL and broadcasts it', async () => {
    publish.mockResolvedValue([{ status: 'accepted', relay: 'wss://one.example' }])
    await publishDmRelays(['wss://one.example', 'wss://one.example/'], PUBKEY, active)

    const signed = (active as unknown as { signEvent: ReturnType<typeof vi.fn> }).signEvent.mock
      .calls[0][0] as { kind: number; tags: string[][] }
    expect(signed.kind).toBe(KIND_DM_RELAYS)
    // Duplicates collapse (trailing slash normalized upstream is the caller's job;
    // here the two distinct strings both survive as given, deduped by exact value).
    expect(signed.tags).toContainEqual(['relay', 'wss://one.example'])

    // Broadcast targets include the defaults for discoverability.
    const opts = publish.mock.calls[0][1] as { relays: string[] }
    expect(opts.relays).toEqual(expect.arrayContaining([...DEFAULT_RELAYS, 'wss://one.example']))
  })

  it('rejects an empty relay set', async () => {
    await expect(publishDmRelays([], PUBKEY, active)).rejects.toThrow(/at least one relay/i)
    expect(publish).not.toHaveBeenCalled()
  })

  it('throws when no relay accepts the event', async () => {
    publish.mockResolvedValue([{ status: 'failed', relay: 'wss://one.example', message: 'nope' }])
    await expect(publishDmRelays(['wss://one.example'], PUBKEY, active)).rejects.toThrow(/nope/)
  })

  it('clears the fetchDmRelays cache so the next read is fresh', async () => {
    // Seed the cache via a fetch, then publish, then confirm the next fetch re-queries.
    queryLocal.mockResolvedValue([relayListEvent(['wss://old.example'])])
    await fetchDmRelays(PUBKEY)
    expect(queryLocal).toHaveBeenCalledTimes(1)
    await fetchDmRelays(PUBKEY) // served from cache
    expect(queryLocal).toHaveBeenCalledTimes(1)

    publish.mockResolvedValue([{ status: 'accepted', relay: 'wss://new.example' }])
    await publishDmRelays(['wss://new.example'], PUBKEY, active)

    await fetchDmRelays(PUBKEY) // cache cleared → re-queries
    expect(queryLocal).toHaveBeenCalledTimes(2)
  })
})
