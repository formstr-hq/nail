import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/store/settings'
import type { Email } from '@/types/mail'
import { isPgpMessage, decryptMessage, type SignatureState } from '@/lib/pgp/openpgp'
import { keyForAddress, allOwnKeypairs } from '@/lib/pgp/keyring'
import { getSessionPassphrase } from '@/lib/pgp/session'

/**
 * The PGP state of the message on screen.
 *
 *  - `none`      — not a PGP message; render the plaintext body as usual.
 *  - `decrypted` — we held the key and read it; `text` is the plaintext and
 *                  `signature` is the honest verdict (see openpgp.ts).
 *  - `locked`    — a PGP message encrypted to one of our alias keys, but that
 *                  key is passphrase-protected and not yet unlocked. Carries the
 *                  fingerprint so the Unlock prompt caches against the right key.
 *  - `no-key`    — encrypted, but not to any key we hold. The blob is all we show.
 *  - `error`     — malformed or otherwise undecryptable. Surface, don't hide.
 */
export type PgpMessageState =
  | { kind: 'none' }
  | { kind: 'decrypted'; text: string; signature: SignatureState }
  | { kind: 'locked'; fingerprint: string }
  | { kind: 'no-key' }
  | { kind: 'error'; reason: string }

/**
 * Detect and decrypt an inline-PGP body. Runs off the settings store's private
 * key and the sender's keyring entry (for signature verification), re-running
 * when the open message or the unlocked passphrase changes.
 *
 * `passphraseNonce` lets the caller force a retry after the user unlocks — the
 * session passphrase lives outside React state, so bumping this is how the
 * "Unlock" button tells the hook to try again.
 */
export function usePgpMessage(email: Email | null, passphraseNonce = 0): PgpMessageState {
  const settings = useSettingsStore((s) => s.settings)
  const [state, setState] = useState<PgpMessageState>({ kind: 'none' })

  const body = email?.body ?? ''
  const isPgp = !!email && isPgpMessage(body)

  const ownKeys = allOwnKeypairs(settings)

  useEffect(() => {
    if (!email || !isPgp) {
      setState({ kind: 'none' })
      return
    }
    if (ownKeys.length === 0) {
      // A PGP body we have no key to even attempt — show the blob, don't error.
      setState({ kind: 'no-key' })
      return
    }

    let alive = true
    void (async () => {
      // Verify the signature against the sender's key if we hold it. `no-key`
      // for verification is fine — the openpgp layer downgrades to unknown-key.
      const senderKey = keyForAddress(settings, email.from.address)
      const armored = extractArmoredMessage(body)

      // The message is encrypted to whichever alias it was sent to, which we
      // can't know without trying — so try every own key. A key that is locked
      // and unopenable is remembered as a fallback: only if NOTHING decrypts do
      // we surface "locked" (with that key's fingerprint) to prompt an unlock.
      let lockedFingerprint: string | null = null
      for (const kp of ownKeys) {
        const passphrase = kp.passphraseProtected
          ? getSessionPassphrase(kp.fingerprint) ?? undefined
          : undefined
        if (kp.passphraseProtected && !passphrase) {
          lockedFingerprint ??= kp.fingerprint
          continue
        }
        try {
          const result = await decryptMessage({
            armored,
            privateKey: kp.privateKey,
            passphrase,
            verificationPublicKeys: senderKey ? [senderKey] : undefined,
          })
          if (alive) setState({ kind: 'decrypted', text: result.text, signature: result.signature })
          return
        } catch (e) {
          // Wrong alias key for this message — routine with several keys. Only a
          // genuinely malformed message (not a key mismatch) is a hard error, and
          // we can't tell reliably per-key, so keep trying and fall through below.
          void e
        }
      }

      if (!alive) return
      // Nothing decrypted. If a locked key might have been the right one, ask to
      // unlock it; otherwise the message simply isn't addressed to any key we hold.
      setState(lockedFingerprint ? { kind: 'locked', fingerprint: lockedFingerprint } : { kind: 'no-key' })
    })()

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    email?.id,
    isPgp,
    body,
    settings.pgpKeys,
    settings.pgpKeyring,
    passphraseNonce,
  ])

  return state
}

/**
 * Pull just the armored PGP block out of a body that may have surrounding text
 * (some clients wrap the block in explanatory lines). openpgp is strict about
 * leading/trailing noise, so slice to the armor boundaries.
 */
function extractArmoredMessage(body: string): string {
  const begin = body.indexOf('-----BEGIN PGP MESSAGE-----')
  const endMarker = '-----END PGP MESSAGE-----'
  const end = body.indexOf(endMarker)
  if (begin === -1 || end === -1) return body
  return body.slice(begin, end + endMarker.length)
}
