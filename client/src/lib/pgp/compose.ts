import type { MailSettings } from '@/lib/nostr/settings'
import { encryptMessage } from './openpgp'
import { keyForAddress, keyringKey } from './keyring'

/**
 * Mail providers that can read message bodies server-side. Sending them
 * plaintext isn't wrong — it's how most email works — but it's worth an honest
 * nudge, so the composer can say "this can be read by the provider". Not a
 * security control, just a prompt; a short static list, matched on the domain.
 */
const CLEARTEXT_PROVIDERS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'aol.com',
])

/** Addresses among the recipients whose provider can read plaintext. */
export function cleartextRecipients(addresses: string[]): string[] {
  return addresses.filter((a) => {
    const domain = keyringKey(a).split('@')[1]
    return domain ? CLEARTEXT_PROVIDERS.has(domain) : false
  })
}

/**
 * Encrypt (and sign, if a private key is present) a plaintext body to every
 * recipient plus the sender.
 *
 * Encrypting back to the sender's OWN key is what keeps the Sent copy readable —
 * every gift wrap (to each recipient AND the self-wrap that files under Sent)
 * carries this same armored body, so it must be decryptable by the sender too.
 *
 * Throws if any recipient has no key (the caller gates the toggle on this, but
 * it is enforced here too so a body is never sent to someone who can't read it)
 * or if the sender has no PGP key at all.
 */
export async function encryptBody(params: {
  body: string
  recipients: string[]
  settings: Pick<
    MailSettings,
    'pgpKeyring' | 'pgpPublicKey' | 'pgpPrivateKey' | 'pgpPassphraseProtected'
  >
  ownAddresses?: string[]
  /** Session passphrase, required when the private key is passphrase-locked. */
  passphrase?: string
}): Promise<string> {
  const { body, recipients, settings, ownAddresses, passphrase } = params
  if (!settings.pgpPublicKey) {
    throw new Error('You have no PGP key yet — generate one in Settings to encrypt.')
  }

  const recipientKeys: string[] = []
  for (const address of recipients) {
    const key = keyForAddress({ ...settings, ownAddresses }, address)
    if (!key) throw new Error(`No PGP key for ${address}.`)
    recipientKeys.push(key)
  }

  return encryptMessage({
    // De-dupe against the sender's own key so it isn't listed twice when the
    // sender is also a recipient.
    recipientPublicKeys: [...new Set([...recipientKeys, settings.pgpPublicKey])],
    text: body,
    signingPrivateKey: settings.pgpPrivateKey,
    signingPassphrase: settings.pgpPassphraseProtected ? passphrase : undefined,
  })
}
