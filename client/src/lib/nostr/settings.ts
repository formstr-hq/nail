import type { ActiveSigner } from '@formstr/signer'
import { getLocalRelay } from './localRelay'
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

  // Stored locally right away; delivered to the user's relays with durable
  // retry if any are unreachable.
  await getLocalRelay().publishEvent(event)
}

// Standing observe on the settings event: cache replay gives an instant local
// read, the network sync brings the latest copy, and later saves from other
// devices arrive live. Returns an unsubscribe function.
export function subscribeSettings(
  pubkey: string,
  active: ActiveSigner,
  onSettings: (settings: MailSettings) => void,
  onReady?: () => void,
): () => void {
  // The store keeps only the replaceable winner, but live multi-relay
  // delivery order isn't guaranteed — ignore anything older than what we saw.
  let latestCreatedAt = 0

  const handle = getLocalRelay().observe(
    [{ kinds: [KIND_SETTINGS], authors: [pubkey], '#d': [SETTINGS_D_TAG], limit: 1 }],
    {
      onEvent: async (event) => {
        if (event.created_at <= latestCreatedAt) return
        latestCreatedAt = event.created_at
        try {
          const plaintext = await active.nip44Decrypt(pubkey, event.content)
          onSettings(JSON.parse(plaintext) as MailSettings)
        } catch {
          // undecryptable/malformed settings event — keep current settings
        }
      },
      onEose: onReady,
    },
  )

  return () => handle.unobserve()
}
