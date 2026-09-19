import type { MailSettings } from '@/app/lib/nostr/settings'
import { encryptMessage } from './openpgp'
import { allKeysForAddress, ownKeypairFor } from './keyring'

/**
 * Encrypt and sign a plaintext body to every recipient plus the sender, using
 * the FROM alias's own keypair.
 *
 * Per-alias keys (settings.ts): the message is signed by, and encrypted back to,
 * the specific alias it is being sent from — not some account-wide key. With a
 * dual set (v4 + v6) the body is encrypted to BOTH halves, and to EVERY key a
 * correspondent's keyring entry holds (multi-key WKD merges), so any key
 * version can decrypt. The alias's v4 half signs — the universally-parsable
 * signature.
 *
 * Throws if the From alias has no key, or if any recipient has no key (the
 * caller gates the toggle on this, but it is enforced here too so a body is
 * never sent to someone who can't read it).
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

  // Encrypt to every key we hold for every recipient, plus every own alias
  // key — de-duped so a key shared between sender and recipient isn't listed
  // twice. `allKeysForAddress` deliberately resolves BOTH own aliases (so a
  // recipient that is another of the user's addresses is encrypted to that
  // alias's own key) and keyring entries (multi-key WKD merges), matching
  // `keyForAddress` exactly — the gate the caller uses to decide who is
  // encryptable.
  const recipientKeys = new Set<string>()
  for (const address of recipients) {
    const keys = allKeysForAddress(settings, address)
    if (!keys.length && address.trim().toLowerCase() !== fromAddress.trim().toLowerCase()) {
      throw new Error(`No PGP key for ${address}.`)
    }
    for (const key of keys) recipientKeys.add(key)
  }
  // The From alias itself: both dual halves so the Sent self-copy stays
  // readable by either key.
  for (const key of allKeysForAddress(settings, fromAddress)) recipientKeys.add(key)

  // Sign with the v4 half when present (universally verifiable), else the
  // legacy single pair.
  const signingKey = own.v4 ?? {
    publicKey: own.publicKey,
    privateKey: own.privateKey,
    fingerprint: own.fingerprint,
  }

  return encryptMessage({
    recipientPublicKeys: [...recipientKeys],
    text: body,
    signingPrivateKey: signingKey.privateKey,
    signingPassphrase: own.passphraseProtected ? passphrase : undefined,
  })
}
