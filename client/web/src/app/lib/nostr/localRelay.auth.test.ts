import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import { createChannelPair, LocalRelayClient, MemoryStorage, RelayService } from '@formstr/local-relay'

const RELAY = 'wss://relay.formstr.app'

/**
 * An in-process stand-in for relay.formstr.app's NIP-42 behaviour, as measured
 * on the wire: it challenges on connect, answers a kind-1059 REQ from an
 * unauthenticated socket with `CLOSED auth-required`, and registers an AUTH
 * asynchronously — a REQ written on the same tick as the AUTH is still refused,
 * and only the `OK` marks the socket as authenticated.
 *
 * local-relay 0.6.2 replayed its REQs on the same tick as the AUTH, so against
 * this relay the kind-1059 stream was refused and never re-sent: mail delivered
 * only to relay.formstr.app never reached a fresh store (a new device, a
 * cleared cache). 0.7.2 waits for the `OK` before replaying.
 */
function fakeAuthRelay(wrap: Event, authDelayMs: number) {
  return () => {
    let authed = false
    const socket = {
      readyState: 0,
      onopen: null as (() => void) | null,
      onmessage: null as ((data: string) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      send(data: string) {
        const msg = JSON.parse(data)
        const reply = (m: unknown[]) => setTimeout(() => socket.onmessage?.(JSON.stringify(m)), 1)
        if (msg[0] === 'AUTH') {
          setTimeout(() => {
            authed = true
            reply(['OK', msg[1].id, true, ''])
          }, authDelayMs)
        } else if (msg[0] === 'REQ') {
          if (!authed) {
            reply(['CLOSED', msg[1], 'auth-required: authentication is required to request these event kinds'])
          } else {
            reply(['EVENT', msg[1], wrap])
            reply(['EOSE', msg[1]])
          }
        }
      },
      close() {
        socket.readyState = 3
        socket.onclose?.()
      },
    }
    setTimeout(() => {
      socket.readyState = 1
      socket.onopen?.()
      socket.onmessage?.(JSON.stringify(['AUTH', 'challenge-1']))
    }, 1)
    return socket
  }
}

async function deliveredFromAuthRelay(authDelayMs: number): Promise<boolean> {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  const wrap = finalizeEvent(
    { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', pk]], content: 'x' },
    generateSecretKey(),
  )

  const pair = createChannelPair()
  const service = new RelayService({
    channel: pair.worker,
    storage: new MemoryStorage(),
    socketFactory: fakeAuthRelay(wrap, authDelayMs),
    // The fixture's ciphertext isn't a real gift wrap; routing is under test.
    verify: () => true,
  })
  await service.start()
  // Wired like localRelay.ts: the worker's AUTH challenge goes to the signer.
  const client = new LocalRelayClient(pair.client, {
    onSignRequest: async (template) => finalizeEvent(template, sk),
  })
  client.setUserRelays([RELAY])
  client.setActiveAccount(pk)
  client.setDmRelays([RELAY])

  try {
    return await new Promise<boolean>((resolve) => {
      client.observe([{ kinds: [1059], '#p': [pk] }], {
        onEvent: (e) => e.id === wrap.id && resolve(true),
      })
      setTimeout(() => resolve(false), 2000)
    })
  } finally {
    await service.stop()
  }
}

describe('local relay NIP-42 AUTH against an AUTH-gated DM relay', () => {
  it('delivers mail that lives only on the AUTH-gated relay', async () => {
    expect(await deliveredFromAuthRelay(30)).toBe(true)
  })

  it('still delivers when the AUTH OK lands after the replay grace window', async () => {
    // A slow mobile link: the relay's OK arrives after local-relay's 600ms
    // grace replay has already been refused. The late OK must replay again.
    expect(await deliveredFromAuthRelay(900)).toBe(true)
  })
})
