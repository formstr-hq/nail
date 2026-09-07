import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Event } from 'nostr-tools'
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { bytesToHex } from 'nostr-tools/utils'
import { KIND_GIFTWRAP } from './constants'

// Hermetic: no worker, no sockets, no signer timeouts (same pattern as
// relays.test.ts). `publish` records every event handed to the local relay.
const publish =
  vi.fn<(...a: unknown[]) => Promise<{ status: string; relay: string; message?: string }[]>>()
const dmRelays = vi.fn<(...a: unknown[]) => Promise<string[]>>()
vi.mock('./localRelay', () => ({
  getLocalRelay: () => ({ publish: (...a: unknown[]) => publish(...a) }),
}))
vi.mock('./relays', () => ({
  fetchDmRelays: (...a: unknown[]) => dmRelays(...a),
}))
vi.mock('./signer', () => ({
  withSignerTimeout: (_label: string, fn: () => unknown) => fn(),
}))

import { publishGiftwrapDeletion } from './delete'

const ME_SK = generateSecretKey()
const ME = getPublicKey(ME_SK)
/** Minimal ActiveSigner stand-in: signs with the account key. */
const active = {
  // finalizeEvent derives pubkey from the secret, so ME is implied.
  signEvent: async (t: { kind: number; created_at: number; tags: string[][]; content: string }) =>
    finalizeEvent(t, ME_SK),
}

const WRAP_ID = 'b'.repeat(64)
// The key that actually signed the gift wrap — embedded via WRAP_KEY_TAG.
const WRAP_SK = generateSecretKey()

beforeEach(() => {
  publish.mockReset()
  dmRelays.mockReset()
  dmRelays.mockResolvedValue(['wss://relay.example'])
  publish.mockResolvedValue([{ status: 'accepted', relay: 'wss://relay.example' }])
})

describe('publishGiftwrapDeletion', () => {
  it('fires BOTH kind-5s when the wrap key is known: wrap-author first, recipient second', async () => {
    const outcome = await publishGiftwrapDeletion({
      giftwrapId: WRAP_ID,
      wrapSecret: bytesToHex(WRAP_SK),
      pubkey: ME,
      active: active as never,
    })

    expect(outcome.attempted).toEqual(['wrap-author', 'recipient'])
    expect(outcome.anyAccepted).toBe(true)
    expect(publish).toHaveBeenCalledTimes(2)

    // The wrap-author event: authored by the ephemeral key, so NIP-09's
    // author-match rule cannot reject it — this is the one that works
    // everywhere. A valid signature is asserted, not just its shape, because
    // the whole mechanism is worthless if this event fails verifyEvent.
    const authorEvent = publish.mock.calls[0][0] as Event
    expect(authorEvent.kind).toBe(5)
    expect(authorEvent.pubkey).toBe(getPublicKey(WRAP_SK))
    expect(authorEvent.tags).toContainEqual(['e', WRAP_ID])
    expect(authorEvent.tags).toContainEqual(['k', String(KIND_GIFTWRAP)])
    expect(verifyEvent(authorEvent)).toBe(true)

    // The recipient event: the fallback for relays that honor addressed-party
    // deletions — and the only attempt possible for legacy wraps. Same tags.
    const recipientEvent = publish.mock.calls[1][0] as Event
    expect(recipientEvent.kind).toBe(5)
    expect(recipientEvent.pubkey).toBe(ME)
    expect(recipientEvent.tags).toContainEqual(['e', WRAP_ID])
    expect(verifyEvent(recipientEvent)).toBe(true)

    expect(authorEvent.id).not.toBe(recipientEvent.id)
  })

  it('fires only the recipient kind-5 for legacy mail without an embedded wrap key', async () => {
    const outcome = await publishGiftwrapDeletion({
      giftwrapId: WRAP_ID,
      pubkey: ME,
      active: active as never,
    })

    expect(outcome.attempted).toEqual(['recipient'])
    expect(publish).toHaveBeenCalledTimes(1)
    const event = publish.mock.calls[0][0] as Event
    expect(event.pubkey).toBe(ME)
    expect(event.kind).toBe(5)
    expect(event.tags).toContainEqual(['e', WRAP_ID])
  })

  it('targets the account’s DM relays (where the wrap actually lives)', async () => {
    await publishGiftwrapDeletion({
      giftwrapId: WRAP_ID,
      wrapSecret: bytesToHex(WRAP_SK),
      pubkey: ME,
      active: active as never,
    })
    expect(dmRelays).toHaveBeenCalledWith(ME)
    expect(publish).toHaveBeenCalledWith(expect.anything(), { relays: ['wss://relay.example'] })
  })

  it('reports anyAccepted false when no relay takes either event — but never throws', async () => {
    publish.mockResolvedValue([{ status: 'rejected', relay: 'wss://relay.example', message: 'x' }])
    const outcome = await publishGiftwrapDeletion({
      giftwrapId: WRAP_ID,
      wrapSecret: bytesToHex(WRAP_SK),
      pubkey: ME,
      active: active as never,
    })
    expect(outcome.anyAccepted).toBe(false)
    // Attempts are still reported: the caller logs what was tried, and the
    // local tombstone (store.markDeleted) is what actually keeps the mail gone.
    expect(outcome.attempted).toEqual(['wrap-author', 'recipient'])
  })

  it('rejects a malformed wrapSecret instead of signing garbage', async () => {
    // hexToBytes is permissive (odd lengths, non-hex → NaN byte); finalizeEvent
    // is the guard — a bogus key must surface as an error, not a bogus event.
    await expect(
      publishGiftwrapDeletion({
        giftwrapId: WRAP_ID,
        wrapSecret: 'zz-not-a-key',
        pubkey: ME,
        active: active as never,
      }),
    ).rejects.toThrow()
  })
})
