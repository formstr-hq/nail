import type { Event } from 'nostr-tools'
import type { ActiveSigner } from '@formstr/signer'
import { getPool, fetchDmRelays, publishToRelays } from './relays'
import { withSignerTimeout } from './signer'
import { KIND_SETTINGS } from './constants'

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

  const relays = await stage('fetchDmRelays', () => fetchDmRelays(pubkey))
  console.info('[settings] publishing to', relays)

  const { ok, failed } = await stage('publish', () => publishToRelays(relays, event))
  console.info('[settings] accepted by', ok, 'refused by', failed)

  if (!ok.length) {
    throw new Error(`Could not save settings: ${failed[0]?.error ?? 'no relay accepted the event'}`)
  }
}

export async function loadSettings(
  pubkey: string,
  active: ActiveSigner,
): Promise<MailSettings | null> {
  const pool = getPool()
  const relays = await stage('load/fetchDmRelays', () => fetchDmRelays(pubkey))

  const events = await stage('load/querySync', () =>
    pool.querySync(
      relays,
      { kinds: [KIND_SETTINGS], authors: [pubkey], '#d': [SETTINGS_D_TAG] },
      {},
    ),
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
    return JSON.parse(plaintext) as MailSettings
  } catch (e) {
    // Was silently swallowed, which makes a stored-but-undecryptable settings
    // event look identical to never having saved: both render an empty form.
    console.error('[settings] found a saved event but could not decrypt it', e)
    return null
  }
}
