import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/store/settings'
import type { Email } from '@/types/mail'
import {
  isPgpMessage,
  parsePgpMessage,
  pkeskKeyIDs,
  keyIDsOfArmored,
  decryptMessage,
  type SignatureState,
} from '@/lib/pgp/openpgp'
import { keyForAddress, keyringKey, ownPrivateKeysFor } from '@/lib/pgp/keyring'
import { getSessionPassphrase } from '@/lib/pgp/session'
import { parseRfc2822 } from '@/lib/mail/rfc2822'

/**
 * The PGP state of the message on screen.
 *
 *  - `none`      — not a PGP message; render the plaintext body as usual.
 *  - `decrypted` — we held the key and read it; `text` (and `html`, if the
 *                  plaintext turned out to itself be a MIME entity — see
 *                  `unwrapMimeEnvelope` below) is the message and `signature`
 *                  is the honest verdict (see openpgp.ts).
 *  - `locked`    — a PGP message encrypted to one of our alias keys, but that
 *                  key is passphrase-protected and not yet unlocked. Carries the
 *                  fingerprint so the Unlock prompt caches against the right key,
 *                  and the owning alias address so the prompt can say WHICH key
 *                  it needs. `wrongPassphrase` is set when we already confirmed
 *                  (via the message's own PKESK key ID — see below) that this
 *                  key IS the target and a passphrase was tried and rejected —
 *                  as opposed to just not having tried one yet.
 *  - `no-key`    — encrypted, but not to any key we hold. The blob is all we show.
 *  - `error`     — malformed or otherwise undecryptable. Surface, don't hide.
 */
export type PgpMessageState =
  | { kind: 'none' }
  | { kind: 'decrypted'; text: string; html?: string; signature: SignatureState }
  | { kind: 'locked'; fingerprint: string; address?: string; wrongPassphrase?: boolean }
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

  // Every address this message's own headers actually name as a recipient —
  // the RFC 2822 `To`/`Cc` the bridge or composer wrote. Not a trust boundary
  // (nothing security-sensitive rides on it: trying the wrong key first can
  // only fail, never leak anything), just an ordering hint, so it's fine to
  // use even though these headers aren't otherwise treated as authoritative.
  const declaredRecipients = new Set(
    [...(email?.to ?? []), ...(email?.cc ?? [])]
      .map((a) => a.address)
      .filter((a): a is string => !!a)
      .map(keyringKey),
  )

  // Flat list of every own DECRYPTION half across all aliases — with dual sets
  // that's two halves per alias, so both v4 and v6 are tried in turn. Each half
  // is stamped with its owning address so a locked prompt can say WHICH alias's
  // key it needs, rather than a generic "unlock your key" that's ambiguous the
  // moment the user holds more than one passphrase-protected alias.
  //
  // Sorted so a half whose alias the message actually names as a recipient is
  // tried FIRST. We can't skip the rest outright — a message may legitimately
  // arrive addressed to an alias not listed here (BCC, or the header simply
  // not naming it) — but for the overwhelmingly common case of one named
  // recipient among several held keys, this is the difference between
  // unlocking on the first try and being prompted for an unrelated alias's
  // passphrase before ever reaching the right one.
  const ownKeys = Object.entries(settings.pgpKeys ?? {})
    .flatMap(([address, kp]) => ownPrivateKeysFor(kp).map((half) => ({ ...half, address })))
    .sort((a, b) => {
      const aNamed = declaredRecipients.has(keyringKey(a.address)) ? 0 : 1
      const bNamed = declaredRecipients.has(keyringKey(b.address)) ? 0 : 1
      return aNamed - bNamed
    })

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

      // Parse the armor ONCE, before trying any key. A malformed message (bad
      // armor, truncated ciphertext — e.g. a bug upstream in how the body was
      // assembled) fails here regardless of which key is tried, so it must
      // surface as a real error rather than being retried per key and
      // eventually misreported as "no-key" once every key has failed on it.
      let message
      try {
        message = await parsePgpMessage(armored)
      } catch (e) {
        if (alive) setState({ kind: 'error', reason: e instanceof Error ? e.message : String(e) })
        return
      }

      // The ciphertext itself names which key(s) it was encrypted to — every
      // PGP session key is wrapped per-recipient in a packet that carries that
      // recipient's key ID in the clear. Read that BEFORE trying anything, so
      // we can go straight to the one key that can actually open this message
      // instead of trying every held key and treating a mismatch as routine.
      // Only when the message hides its recipient (rare: symmetric-only, or a
      // deliberate "hidden recipient" wildcard ID) is there nothing to match,
      // and every held key genuinely has to be tried — that's the one case
      // `candidates` falls back to the full list.
      const targetKeyIDs = pkeskKeyIDs(message)
      let candidates = ownKeys
      if (targetKeyIDs.length > 0) {
        const withKeyIDs = await Promise.all(
          ownKeys.map(async (kp) => ({ kp, keyIDs: await keyIDsOfArmored(kp.privateKey) })),
        )
        candidates = withKeyIDs
          .filter(({ keyIDs }) => keyIDs.some((id) => targetKeyIDs.includes(id)))
          .map(({ kp }) => kp)
        console.debug(
          '[pgp] message targets key IDs',
          targetKeyIDs,
          '-> matching held keys:',
          candidates.map((k) => k.address),
        )
        if (!alive) return
        if (candidates.length === 0) {
          // We know EXACTLY which key this needs, and it isn't one we hold —
          // no reason to try anything else, and no "locked" prompt to show
          // for a key we don't have in the first place.
          setState({ kind: 'no-key' })
          return
        }
      }

      // Try only the confirmed candidate(s) (or, lacking a determinable
      // target, every held key as a last resort). A key that is locked and
      // unopenable is remembered as a fallback: only if NOTHING decrypts do we
      // surface "locked" (with that key's fingerprint) to prompt an unlock.
      let lockedFingerprint: string | null = null
      let lockedAddress: string | undefined
      let wrongPassphrase = false
      for (const kp of candidates) {
        // One passphrase locks BOTH dual halves, so the cache is keyed by the
        // keypair's own fingerprint — not the half's, which differs between v4
        // and v6 and would otherwise make unlocking one half never unlock the
        // other (see keyring.ts's DecryptionHalf).
        const passphrase = kp.passphraseProtected
          ? getSessionPassphrase(kp.keypairFingerprint) ?? undefined
          : undefined
        if (kp.passphraseProtected && !passphrase) {
          console.debug('[pgp] key locked, no cached passphrase for', kp.address, kp.keypairFingerprint)
          if (lockedFingerprint === null) {
            lockedFingerprint = kp.keypairFingerprint
            lockedAddress = kp.address
          }
          continue
        }
        try {
          const result = await decryptMessage({
            message,
            privateKey: kp.privateKey,
            passphrase,
            verificationPublicKeys: senderKey ? [senderKey] : undefined,
          })
          console.debug('[pgp] decrypted with', kp.keypairFingerprint)
          if (alive) setState({ kind: 'decrypted', ...(await unwrapMimeEnvelope(result.text)), signature: result.signature })
          return
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          console.debug(
            '[pgp] key attempt failed',
            kp.keypairFingerprint,
            'hadCachedPassphrase',
            kp.passphraseProtected ? !!passphrase : 'n/a',
            reason,
          )
          // We only reach here having already confirmed (via the PKESK key ID
          // match above) that this key IS the message's target — UNLESS we
          // fell back to trying every key because the target couldn't be
          // determined, in which case a mismatch is still routine. When the
          // target WAS confirmed, a passphrase-shaped failure means the
          // passphrase itself was wrong, not "wrong key" — and that must be
          // told apart, or re-unlocking with no feedback is exactly the
          // confusing "nothing happened" symptom this exists to prevent.
          if (targetKeyIDs.length > 0 && /incorrect key passphrase/i.test(reason)) {
            wrongPassphrase = true
            if (lockedFingerprint === null) {
              lockedFingerprint = kp.keypairFingerprint
              lockedAddress = kp.address
            }
          }
        }
      }

      if (!alive) return
      // Nothing decrypted. If a locked key might have been the right one, ask to
      // unlock it; otherwise the message simply isn't addressed to any key we hold.
      console.debug(
        '[pgp] no key decrypted this message; lockedFingerprint =',
        lockedAddress,
        lockedFingerprint,
        'wrongPassphrase',
        wrongPassphrase,
      )
      setState(
        lockedFingerprint
          ? { kind: 'locked', fingerprint: lockedFingerprint, address: lockedAddress, wrongPassphrase }
          : { kind: 'no-key' },
      )
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

/**
 * PGP/MIME (RFC 3156) encrypts the ORIGINAL MIME body verbatim, headers and
 * all — decrypting hands back another full MIME entity (`Content-Type:
 * multipart/...`, boundaries, `Content-Transfer-Encoding`), not prose to
 * display as-is. Proton in particular sends this way for automatic external
 * PGP. Detect that shape and parse it exactly like the outer message (see
 * receive.ts), so the reader sees the actual text/html instead of raw MIME
 * source. A plain inline-PGP message (just written text) never starts with a
 * header line, so it passes through unchanged.
 */
async function unwrapMimeEnvelope(text: string): Promise<{ text: string; html?: string }> {
  if (!/^\s*content-type\s*:/i.test(text)) return { text }
  try {
    const inner = await parseRfc2822(new TextEncoder().encode(text))
    return { text: inner.text ?? text, html: inner.html ?? undefined }
  } catch {
    // Looked MIME-shaped but didn't parse — fall back to the raw decrypted text.
    return { text }
  }
}
