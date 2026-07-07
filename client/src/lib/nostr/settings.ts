import { finalizeEvent, nip44 } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { getPool, fetchDmRelays } from './relays'
import { KIND_SETTINGS } from './constants'
import type { Signer } from './signer'

const SETTINGS_D_TAG = 'mail-settings'

export interface MailSettings {
  senderAddress?: string   // e.g. alice@mail.formstr.app
  signature?: string       // appended to outgoing emails
  bridgeDomains?: string[] // preferred bridge domains
}

export async function saveSettings(
  settings: MailSettings,
  pubkey: string,
  sk: Uint8Array,
): Promise<void> {
  const conversationKey = nip44.getConversationKey(sk, pubkey)
  const encrypted = nip44.encrypt(JSON.stringify(settings), conversationKey)

  const event = finalizeEvent(
    {
      kind: KIND_SETTINGS,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', SETTINGS_D_TAG]],
      content: encrypted,
    },
    sk,
  )

  const pool = getPool()
  const relays = await fetchDmRelays(pubkey)
  await Promise.all(relays.map((url) => pool.publish([url], event)))
}

export async function loadSettings(
  pubkey: string,
  signer: Signer,
  sk: Uint8Array | null,
): Promise<MailSettings | null> {
  const pool = getPool()
  const relays = await fetchDmRelays(pubkey)

  const events = await pool.querySync(
    relays,
    { kinds: [KIND_SETTINGS], authors: [pubkey], '#d': [SETTINGS_D_TAG] },
    {},
  )

  if (!events.length) return null

  const latest = events.sort((a: Event, b: Event) => b.created_at - a.created_at)[0]

  try {
    // Private settings are encrypted to self — use sk directly if available,
    // otherwise fall back to signer (NIP-07 nip44.decrypt)
    let plaintext: string
    if (sk) {
      const conversationKey = nip44.getConversationKey(sk, pubkey)
      plaintext = nip44.decrypt(latest.content, conversationKey)
    } else {
      plaintext = await signer.decrypt(pubkey, latest.content)
    }
    return JSON.parse(plaintext) as MailSettings
  } catch {
    return null
  }
}
