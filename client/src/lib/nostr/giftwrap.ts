import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip44,
  nip19,
} from 'nostr-tools'
import type { UnsignedEvent, Event } from 'nostr-tools'
import { KIND_GIFTWRAP, KIND_MAIL } from './constants'
import type { Signer } from './signer'

function randomTimestamp(): number {
  // Up to 2 days in the past per NIP-59 (never future — relays reject future timestamps)
  const now = Math.floor(Date.now() / 1000)
  return now - Math.floor(Math.random() * 172800)
}

export function buildMailRumor(
  senderPubkey: string,
  recipientPubkey: string,
  rfc2822Content: string,
): UnsignedEvent {
  return {
    kind: KIND_MAIL,
    pubkey: senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkey]],
    content: rfc2822Content,
  }
}

export function giftWrap(
  rumor: UnsignedEvent,
  recipientPubkey: string,
): Event {
  const ephemeralSk = generateSecretKey()
  const ephemeralPk = getPublicKey(ephemeralSk)

  const conversationKey = nip44.getConversationKey(ephemeralSk, recipientPubkey)
  const sealed = nip44.encrypt(JSON.stringify(rumor), conversationKey)

  const wrapEvent: UnsignedEvent = {
    kind: KIND_GIFTWRAP,
    pubkey: ephemeralPk,
    created_at: randomTimestamp(),
    tags: [
      ['p', recipientPubkey],
      ['k', String(KIND_MAIL)],
    ],
    content: sealed,
  }

  return finalizeEvent(wrapEvent, ephemeralSk)
}

export async function unwrapGiftWrap(
  event: Event,
  signer: Signer,
): Promise<UnsignedEvent | null> {
  try {
    const plaintext = await signer.decrypt(event.pubkey, event.content)
    return JSON.parse(plaintext) as UnsignedEvent
  } catch {
    return null
  }
}

export function pubkeyToNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey)
}

export function npubToPubkey(npub: string): string {
  const decoded = nip19.decode(npub)
  if (decoded.type !== 'npub') throw new Error('Not an npub')
  return decoded.data
}
