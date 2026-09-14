import { useMemo, useState } from 'react'
import type { MailSettings } from '@/app/lib/nostr/settings'
import { addressesMissingKeys, ownKeypairFor } from '@/app/lib/pgp/keyring'
import { usePgpDiscovery } from '@/app/hooks/usePgpDiscovery'

/**
 * The composer's PGP encryption gate.
 *
 * Keys are per-alias, so encryption needs a key for the FROM alias
 * specifically (that's what signs and self-encrypts). Recipient keys are
 * PER-RECIPIENT: those we hold keys for get encrypted mail, those without
 * get plaintext (mixed delivery) — a missing key is no longer a blocker, it
 * just demotes that one recipient. `missingKeys` names the gaps so the UI
 * can explain who is being sent plaintext.
 */
export function useComposerEncryption(input: {
  settings: MailSettings
  fromAddress: string
  recipients: string[]
  /** Auto-discover missing recipient keys from the keyserver. A hit lands in
   *  the keyring and flips canEncrypt on by itself — this is what makes "have
   *  a key ⇒ encrypt" automatic rather than manual-import-only. */
  discover: boolean
}) {
  const { settings, fromAddress, recipients, discover } = input

  const hasFromKey = Boolean(ownKeypairFor(settings, fromAddress))
  const missingKeys = useMemo(
    () =>
      recipients.length
        ? addressesMissingKeys(
            { pgpKeyring: settings.pgpKeyring, pgpKeys: settings.pgpKeys },
            recipients,
          )
        : [],
    [recipients, settings.pgpKeyring, settings.pgpKeys],
  )
  const canEncrypt = hasFromKey && recipients.length > 0
  const { discovering } = usePgpDiscovery(discover ? recipients : [])

  // Encrypt-by-default whenever it's possible. Holding a public key for every
  // recipient IS the signal that they use PGP — if the user went to the trouble
  // of having someone's key, that's exactly who they want to encrypt to,
  // regardless of which provider hosts the address. So the default is simply
  // "on when we can", and recipients WITHOUT a key are demoted to plaintext
  // (mixed delivery) rather than blocking encryption entirely. `userOverride`
  // records a manual flip so this reactive default never fights a deliberate
  // choice: once the user sets the toggle, their pick wins until encryption
  // stops being possible.
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  // Once encryption becomes impossible a manual override is moot, so the
  // reactive default can take back over. Derived rather than reset by an
  // effect: the stale override is simply ignored while canEncrypt is false.
  const effectiveOverride = canEncrypt ? userOverride : null
  const encrypt = canEncrypt && (effectiveOverride ?? true)
  // The per-recipient state this message will go out in, for the status line.
  // `null` means everything is encrypted (or encryption is simply off).
  const mixed = encrypt && missingKeys.length > 0

  return {
    canEncrypt,
    encrypt,
    mixed,
    missingKeys,
    discovering,
    hasFromKey,
    setUserOverride,
  }
}

/** Why the message will go out (partly) unencrypted, if it will — used to
 *  explain the red lock when the user clicks it. `action` promotes the fix to
 *  a CTA when there's a concrete next step (set up a key). `null` means it IS
 *  fully encrypted. */
export interface NoEncryptReason {
  text: string
  cta?: string
  action?: () => void
}

export function noEncryptReason(input: {
  encrypt: boolean
  mixed: boolean
  missingKeys: string[]
  hasFromKey: boolean
  recipientCount: number
  fromAddress: string
  onOpenEncryptionSettings?: () => void
}): NoEncryptReason | null {
  const { encrypt, mixed, missingKeys, hasFromKey, recipientCount, fromAddress, onOpenEncryptionSettings } = input
  if (encrypt) {
    return mixed
      ? {
          text: `No encryption key found for ${missingKeys.join(', ')} — they'll receive this as plaintext; everyone else gets encrypted mail.`,
        }
      : null
  }
  if (!hasFromKey) {
    return {
      text: `You don't have a PGP key for ${fromAddress}.`,
      cta: 'Set up encryption',
      action: onOpenEncryptionSettings,
    }
  }
  if (recipientCount === 0) {
    return { text: 'Add a recipient to encrypt this message.' }
  }
  // canEncrypt is true but the user turned it off manually.
  return { text: 'Encryption is off for this message. Click the lock to turn it on.' }
}