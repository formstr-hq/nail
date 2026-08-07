import type { Event } from 'nostr-tools'
import type { ActiveSigner } from '@formstr/signer'
import { fetchDmRelays } from './relays'
import { getLocalRelay, queryLocal } from './localRelay'
import { withSignerTimeout } from './signer'
import { BRIDGE_DOMAIN, KIND_SETTINGS } from './constants'

const SETTINGS_D_TAG = 'mail-settings'

/**
 * Time each stage of a settings round-trip and name the one that stalls.
 *
 * Settings cross three very different components — the signer (which may be a
 * browser extension or a NIP-46 bunker on the far side of a relay), the relay
 * query, and the publish. Only the last two have timeouts, so a signer that
 * never answers leaves the UI on "Saving…" forever with nothing in the console.
 */
async function stage<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  const stall = setTimeout(
    () => console.warn(`[settings] "${label}" still pending after 5s — the stall is here`),
    5000,
  )
  try {
    const result = await fn()
    console.info(`[settings] ${label}: ok in ${Math.round(performance.now() - t0)}ms`)
    return result
  } catch (e) {
    console.error(`[settings] ${label}: FAILED after ${Math.round(performance.now() - t0)}ms`, e)
    throw e
  } finally {
    clearTimeout(stall)
  }
}

export interface MailSettings {
  senderAddress?: string   // e.g. alice@mailstr.app
  signature?: string       // appended to outgoing emails
  bridgeDomains?: string[] // preferred bridge domains
}

export async function saveSettings(
  settings: MailSettings,
  pubkey: string,
  active: ActiveSigner,
): Promise<void> {
  // Private settings are NIP-44 encrypted to self
  const encrypted = await stage('signer.nip44Encrypt', () =>
    withSignerTimeout('nip44Encrypt', () =>
      active.nip44Encrypt(pubkey, JSON.stringify(settings)),
    ),
  )

  const event = await stage('signer.signEvent', () =>
    withSignerTimeout('signEvent', () =>
      active.signEvent({
        kind: KIND_SETTINGS,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', SETTINGS_D_TAG]],
        content: encrypted,
      }),
    ),
  )

  // Settings live on the user's DM relays (that's where loadSettings reads them),
  // so hint the worker toward them; the durable outbox re-delivers to any that
  // don't accept immediately.
  const relays = await stage('fetchDmRelays', () => fetchDmRelays(pubkey))
  console.info('[settings] publishing to', relays)

  const outcomes = await stage('publish', () =>
    getLocalRelay().publish(event, { relays }),
  )
  const accepted = outcomes.filter((o) => o.status === 'accepted').map((o) => o.relay)
  console.info('[settings] accepted by', accepted)

  if (!accepted.length) {
    const reason = outcomes.find((o) => o.message)?.message ?? 'no relay accepted the event'
    throw new Error(`Could not save settings: ${reason}`)
  }
}

export async function loadSettings(
  pubkey: string,
  active: ActiveSigner,
): Promise<MailSettings | null> {
  const relays = await stage('load/fetchDmRelays', () => fetchDmRelays(pubkey))

  const events = await stage('load/query', () =>
    queryLocal([{ kinds: [KIND_SETTINGS], authors: [pubkey], '#d': [SETTINGS_D_TAG] }], {
      relays,
    }),
  )

  if (!events.length) {
    console.warn('[settings] no kind-30078 event found on', relays, '— nothing was ever saved')
    return null
  }

  const latest = events.sort((a: Event, b: Event) => b.created_at - a.created_at)[0]

  try {
    const plaintext = await stage('load/signer.nip44Decrypt', () =>
      withSignerTimeout('nip44Decrypt', () => active.nip44Decrypt(pubkey, latest.content)),
    )
    const settings = JSON.parse(plaintext) as MailSettings

    // Heal a senderAddress persisted as a bare localpart (an early build let
    // the Settings picker save just `abhay` instead of `abhay@mailstr.app`).
    // Left bare, it fails the `splitAddress`-based ownership check in send.ts
    // and blocks sending entirely. The only domain names are registered on is
    // BRIDGE_DOMAIN, so that's the correct qualification.
    if (settings.senderAddress && !settings.senderAddress.includes('@')) {
      settings.senderAddress = `${settings.senderAddress}@${BRIDGE_DOMAIN}`
    }

    return settings
  } catch (e) {
    // Was silently swallowed, which makes a stored-but-undecryptable settings
    // event look identical to never having saved: both render an empty form.
    console.error('[settings] found a saved event but could not decrypt it', e)
    return null
  }
}
