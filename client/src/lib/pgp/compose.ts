import type { MailSettings } from '@/lib/nostr/settings'
import { encryptMessage } from './openpgp'
import { keyForAddress, ownKeypairFor, keyringKey } from './keyring'

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
 * Encrypt and sign a plaintext body to every recipient plus the sender, using
 * the FROM alias's own keypair.
 *
 * Per-alias keys (settings.ts): the message is signed by, and encrypted back to,
 * the specific alias it is being sent from — not some account-wide key. That
 * self-encryption keeps the Sent copy readable (every gift wrap, including the
 * self-wrap that files under Sent, carries this same armored body) while keeping
 * the alias's identity distinct.
 *
 * Throws if the From alias has no key, or if any recipient has no key (the caller
 * gates the toggle on this, but it is enforced here too so a body is never sent
 * to someone who can't read it).
 */
export async function encryptBody(params: {
  body: string
  /** The alias this is sent from — selects which own keypair signs + self-encrypts. */
  fromAddress: string
  recipients: string[]
  settings: Pick<MailSettings, 'pgpKeyring' | 'pgpKeys'>
  /** Session passphrase for the From alias's key, when it is passphrase-locked. */
  passphrase?: string
}): Promise<string> {
  const { body, fromAddress, recipients, settings, passphrase } = params

  const own = ownKeypairFor(settings, fromAddress)
  if (!own) {
    throw new Error(`No PGP key for ${fromAddress} — generate one in Settings to encrypt.`)
  }

  const recipientKeys: string[] = []
  for (const address of recipients) {
    const key = keyForAddress(settings, address)
    if (!key) throw new Error(`No PGP key for ${address}.`)
    recipientKeys.push(key)
  }

  return encryptMessage({
    // De-dupe against the sender's own key so it isn't listed twice when the
    // sender is also a recipient.
    recipientPublicKeys: [...new Set([...recipientKeys, own.publicKey])],
    text: body,
    signingPrivateKey: own.privateKey,
    signingPassphrase: own.passphraseProtected ? passphrase : undefined,
  })
}
