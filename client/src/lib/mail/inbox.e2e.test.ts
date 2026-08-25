import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
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

  // The whole "delete forever" mechanism, end to end in memory: a wrap that
  // embeds its author's ephemeral key (WRAP_KEY_TAG) is decodable, the
  // captured secret authors a NIP-09 kind-5, and the local relay — which only
  // honors deletions whose author matches the target event — purges the wrap
  // from the store. A fresh observe then replays nothing. This is also the
  // regression guard for the claim client code makes in lib/nostr/delete.ts.
  it('delete forever: the embedded wrap key purges the wrap from the local relay', async () => {
    const { f, client } = await wire()
    client.setActiveAccount(ME)
    client.setDmRelays(['wss://dm1'])
    await settle()

    const ephemeralSk = generateSecretKey()
    const rumor = buildMailRumor({
      senderPubkey: ME,
      recipientPubkey: ME,
      rfc2822: RFC,
      wrapSecret: ephemeralSk,
    })
    const wrap = await sealAndWrap(rumor, ME, keySigner(ME_SK), ephemeralSk)

    const decodes: Promise<string | undefined>[] = []
    const first = client.observe(
      [{ kinds: [1059], '#p': [ME] }],
      {
        onEvent: (e: Event) => {
          decodes.push(
            decodeGiftWrap(e, keySigner(ME_SK), null, ME).then((out) =>
              'email' in out ? out.wrapSecret : undefined,
            ),
          )
        },
      },
      { relays: ['wss://dm1'] },
    )
    await settle()

    const sock = f.last('wss://dm1')
    sock.open()
    sock.emit(['EVENT', reqId(sock), wrap])
    sock.emit(['EOSE', reqId(sock)])
    await settle()

    const secrets = await Promise.all(decodes)
    expect(secrets[0]).toBeDefined()

    // Delete as the wrap's author — exactly what publishGiftwrapDeletion does.
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: NOW,
        tags: [['e', wrap.id], ['k', '1059']],
        content: '',
      },
      hexToBytes(secrets[0]!),
    )
    expect(deletion.pubkey).toBe(wrap.pubkey)
    client.publish(deletion, { relays: ['wss://dm1'] })
    await settle()

    first.unobserve()

    // A brand-new observe replays the store: the purged wrap must be gone.
    const replayed: Event[] = []
    client.observe(
      [{ kinds: [1059], '#p': [ME] }],
      { onEvent: (e: Event) => replayed.push(e) },
      { relays: ['wss://dm1'] },
    )
    await settle()
    expect(replayed).toHaveLength(0)
  })
})
