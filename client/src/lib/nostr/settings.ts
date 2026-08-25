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
  onboardedAt?: number     // ms epoch the user finished relay onboarding; its
                           // presence is the "seen once, any device" flag —
                           // this event is NIP-44 synced across devices
  mailIndexKey?: string    // 32-byte hex secret keying the HMAC that obfuscates
                           // per-mail metadata coordinates (see mailMeta.ts).
                           // Generated once, then synced here so every device
                           // derives the same opaque `d` tags. Never leaves the
                           // encrypted settings blob.

  // ── OpenPGP (see lib/pgp/). Content-level encryption on top of the gift-wrap
  // transport, for interop with the outside email world. ──
  pgpPrivateKey?: string   // The user's ARMORED private key. Secret material,
                           // but it rides inside this NIP-44-encrypted settings
                           // blob exactly like mailIndexKey, so it syncs across
                           // devices and never hits a server in the clear. May
                           // itself be passphrase-encrypted (see pgpPassphrase-
                           // Protected) for a second factor.
  pgpPublicKey?: string    // The matching ARMORED public key. Redundant with the
                           // private key but kept split so the common read/keyring
                           // paths never parse the secret.
  pgpPassphraseProtected?: boolean // True when pgpPrivateKey is passphrase-locked
                           // and the user must be prompted to unlock it to sign/
                           // decrypt. Off by default to keep first-run frictionless.
  pgpKeyring?: Record<string, string> // Correspondents' ARMORED PUBLIC keys,
                           // keyed by lowercased email address. Public keys only —
                           // safe to sync. Populated by manual import in v1.
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

/**
 * The outcome of a settings load, rich enough to write back safely.
 *
 * `settings` is null both when nothing was ever saved AND when an event exists
 * but couldn't be decrypted — indistinguishable from the settings alone. That
 * gap is dangerous for anything that then SAVES (like minting the mail index
 * key): overwriting a present-but-unreadable event would silently drop whatever
 * it held. So this also reports whether an event was actually seen on the relays
 * and its `version` (the newest event's `created_at`), letting a writer refuse
 * to clobber an event it couldn't read.
 */
export interface SettingsLoad {
  settings: MailSettings | null
  /** An event was found on the relays, whatever the decrypt outcome. */
  eventExists: boolean
  /** `created_at` of the newest settings event seen, if any. */
  version?: number
}

export async function loadSettingsDetailed(
  pubkey: string,
  active: ActiveSigner,
): Promise<SettingsLoad> {
  const relays = await stage('load/fetchDmRelays', () => fetchDmRelays(pubkey))

  const events = await stage('load/query', () =>
    queryLocal([{ kinds: [KIND_SETTINGS], authors: [pubkey], '#d': [SETTINGS_D_TAG] }], {
      relays,
    }),
  )

  if (!events.length) {
    console.warn('[settings] no kind-30078 event found on', relays, '— nothing was ever saved')
    return { settings: null, eventExists: false }
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

    return { settings, eventExists: true, version: latest.created_at }
  } catch (e) {
    // Was silently swallowed, which makes a stored-but-undecryptable settings
    // event look identical to never having saved: both render an empty form.
    // The `eventExists` flag is how a writer avoids overwriting it anyway.
    console.error('[settings] found a saved event but could not decrypt it', e)
    return { settings: null, eventExists: true, version: latest.created_at }
  }
}

export async function loadSettings(
  pubkey: string,
  active: ActiveSigner,
): Promise<MailSettings | null> {
  return (await loadSettingsDetailed(pubkey, active)).settings
}
