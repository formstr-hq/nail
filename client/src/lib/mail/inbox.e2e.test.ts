import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools'
import {
  RelayService,
  LocalRelayClient,
  createChannelPair,
  MemoryStorage,
} from '@formstr/local-relay'
import { fakeSocketFactory } from '@formstr/local-relay/testkit'
import { buildMailRumor, sealAndWrap, keySigner } from '@protocol'
import { decodeGiftWrap } from './receive'

// decodeGiftWrap resolves an unproven sender's display name via a kind-0 lookup,
// which would spin up the real relay worker. Stub it so this test stays hermetic
// and exercises only the receive transport + decode.
vi.mock('@/lib/nostr/profile', () => ({
  fetchProfileName: vi.fn(async () => null),
  clearProfileCache: vi.fn(),
}))

const NOW = 1_000_000
// Exceeds the worker's ingest flush and lets channel microtasks run.
const settle = () => new Promise((r) => setTimeout(r, 80))
const reqId = (sock: { sent: any[] }) =>
  sock.sent.filter((m) => m[0] === 'REQ')[0][1] as string

const ME_SK = generateSecretKey()
const ME = getPublicKey(ME_SK)

const RFC =
  ['From: me@mailstr.app', 'To: me@mailstr.app', 'Subject: e2e', '', 'body'].join('\r\n')

/** A real NIP-59 gift wrap addressed to ME, self-sealed (own-seal path). */
async function wrapToMe(): Promise<Event> {
  const rumor = buildMailRumor({ senderPubkey: ME, recipientPubkey: ME, rfc2822: RFC })
  return sealAndWrap(rumor, ME, keySigner(ME_SK))
}

/** Stand up an in-memory worker (fake sockets, no IndexedDB) + a wired client. */
async function wire() {
  const { client: clientCh, worker: workerCh } = createChannelPair()
  const f = fakeSocketFactory()
  const service = new RelayService({
    channel: workerCh,
    socketFactory: f.factory,
    storage: new MemoryStorage(),
    verify: () => true,
    now: () => NOW,
  })
  await service.start()
  const client = new LocalRelayClient(clientCh, { unobserveGraceMs: 0 })
  return { f, client }
}

describe('inbox receive over the local relay', () => {
  // The exact wiring useInbox performs: point the worker at the DM inbox relays,
  // observe the kind-1059 stream, and decode what comes back. Proves the pipeline
  // end to end against a controllable relay — anything that still fails live is
  // relay-side (e.g. a relay demanding NIP-42 AUTH), not this wiring.
  it('reads a gift wrap from the DM inbox relay and decodes it to an email', async () => {
    const { f, client } = await wire()
    client.setUserRelays(['wss://read1']) // general read relays — mail does NOT live here
    client.setActiveAccount(ME)
    client.setDmRelays(['wss://dm1']) // NIP-17 DM inbox — where mail lives
    await settle()

    const wrap = await wrapToMe()

    const emails: { from: { address: string }; subject: string }[] = []
    const decodes: Promise<void>[] = []
    client.observe(
      [{ kinds: [1059], '#p': [ME] }],
      {
        onEvent: (e: Event) => {
          decodes.push(
            decodeGiftWrap(e, keySigner(ME_SK), null, ME).then((out) => {
              if ('email' in out) emails.push(out.email)
            }),
          )
        },
      },
      { relays: ['wss://dm1'] },
    )
    await settle()

    // The kind-1059 read reached the DM inbox relay.
    expect(f.count('wss://dm1')).toBe(1)
    const sock = f.last('wss://dm1')
    sock.open()
    sock.emit(['EVENT', reqId(sock), wrap])
    sock.emit(['EOSE', reqId(sock)])
    await settle()
    await Promise.all(decodes)

    expect(emails).toHaveLength(1)
    expect(emails[0].from.address).toBe('me@mailstr.app')
    expect(emails[0].subject).toBe('e2e')
  })
})
