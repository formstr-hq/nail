import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/store/settings'
import type { Email } from '@/types/mail'
import { isPgpMessage, decryptMessage, type SignatureState } from '@/lib/pgp/openpgp'
import { keyForAddress } from '@/lib/pgp/keyring'
import { getSessionPassphrase } from '@/lib/pgp/session'

/**
 * The PGP state of the message on screen.
 *
 *  - `none`      — not a PGP message; render the plaintext body as usual.
 *  - `decrypted` — we held the key and read it; `text` is the plaintext and
 *                  `signature` is the honest verdict (see openpgp.ts).
 *  - `locked`    — a PGP message we could decrypt, but the private key is
 *                  passphrase-protected and not yet unlocked this session.
 *  - `no-key`    — encrypted, but not to a key we hold. The armored blob is all
 *                  we can show.
 *  - `error`     — malformed or otherwise undecryptable. Surface, don't hide.
 */
export type PgpMessageState =
  | { kind: 'none' }
  | { kind: 'decrypted'; text: string; signature: SignatureState }
  | { kind: 'locked' }
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

  useEffect(() => {
    if (!email || !isPgp) {
      setState({ kind: 'none' })
      return
    }
    if (!settings.pgpPrivateKey) {
      // A PGP body we have no key to even attempt — show the blob, don't error.
      setState({ kind: 'no-key' })
      return
    }

    let alive = true
    void (async () => {
      const passphrase = settings.pgpPassphraseProtected
        ? getSessionPassphrase() ?? undefined
        : undefined
      if (settings.pgpPassphraseProtected && !passphrase) {
        setState({ kind: 'locked' })
        return
      }

      // Verify the signature against the sender's key if we hold it. `no-key`
      // for verification is fine — the openpgp layer downgrades to unknown-key.
      const senderKey = keyForAddress(
        { pgpKeyring: settings.pgpKeyring, pgpPublicKey: settings.pgpPublicKey },
        email.from.address,
      )

      try {
        const result = await decryptMessage({
          armored: extractArmoredMessage(body),
          privateKey: settings.pgpPrivateKey!,
          passphrase,
          verificationPublicKeys: senderKey ? [senderKey] : undefined,
        })
        if (alive) setState({ kind: 'decrypted', text: result.text, signature: result.signature })
      } catch (e) {
        if (!alive) return
        const message = e instanceof Error ? e.message : String(e)
        // A wrong/absent session key manifests as a decryption error; tell the
        // "not our key" case apart from genuine corruption so the UI can show
        // the blob rather than a scary error for mail simply not addressed to us.
        if (/no.*decryption key|session key/i.test(message)) setState({ kind: 'no-key' })
        else setState({ kind: 'error', reason: message })
      }
    })()

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    email?.id,
    isPgp,
    body,
    settings.pgpPrivateKey,
    settings.pgpPassphraseProtected,
    settings.pgpPublicKey,
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
