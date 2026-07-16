import type { Event } from 'nostr-tools'
import type { ActiveSigner } from '@formstr/signer'
import { getPool, fetchDmRelays } from './relays'
import { KIND_SETTINGS } from './constants'

const SETTINGS_D_TAG = 'mail-settings'

export interface MailSettings {
  senderAddress?: string   // e.g. alice@mail.formstr.app
  signature?: string       // appended to outgoing emails
  bridgeDomains?: string[] // preferred bridge domains
}

export async function saveSettings(
  settings: MailSettings,
  pubkey: string,
  active: ActiveSigner,
): Promise<void> {
  // Private settings are NIP-44 encrypted to self
  const encrypted = await active.nip44Encrypt(pubkey, JSON.stringify(settings))

  const event = await active.signEvent({
    kind: KIND_SETTINGS,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', SETTINGS_D_TAG]],
    content: encrypted,
  })

  const pool = getPool()
  const relays = await fetchDmRelays(pubkey)
  await Promise.all(relays.map((url) => pool.publish([url], event)))
}

export async function loadSettings(
  pubkey: string,
  active: ActiveSigner,
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
    const plaintext = await active.nip44Decrypt(pubkey, latest.content)
    return JSON.parse(plaintext) as MailSettings
  } catch {
    return null
  }
}
