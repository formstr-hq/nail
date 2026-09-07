import * as openpgp from 'openpgp'

/**
 * The OpenPGP layer, as a small typed surface over openpgp.js.
 *
 * This is intentionally the ONLY module that imports `openpgp` directly: every
 * other part of the app speaks in armored strings and the plain result types
 * below, so the library never leaks into the mailbox's own types and can be
 * swapped or upgraded behind this file.
 *
 * Design notes that the rest of the app relies on:
 *  - Keys move as ASCII-armored strings (`-----BEGIN PGP ...-----`). That is
 *    the interoperable wire form and exactly what lands in the encrypted
 *    settings event and the correspondent keyring.
 *  - The user's PRIVATE key never leaves the device in the clear. It rides in
 *    the NIP-44-encrypted settings event like `mailIndexKey`; an optional
 *    passphrase encrypts it a second time at rest here.
 *  - Signature results are reported HONESTLY and granularly (see `SignatureState`)
 *    rather than as a boolean — the reader is told which check actually passed,
 *    mirroring the SenderProof philosophy in types/mail.ts.
 */

/** Curve25519 by default: small, fast, modern, and universally interoperable. */
export type KeyType = 'curve25519' | 'rsa'

/** openpgp's per-signature verification record; the type isn't re-exported. */
type VerificationResult = Awaited<ReturnType<typeof openpgp.decrypt>>['signatures'][number]

export interface GeneratedKey {
  /** Armored public key — safe to publish; hand to correspondents. */
  publicKey: string
  /** Armored private key — secret. Passphrase-encrypted here iff one was given. */
  privateKey: string
  fingerprint: string
}

/**
 * One half of the DUAL-KEY setup every alias carries. Each alias gets TWO
 * independent keypairs generated in the same instant:
 *  - `v4`   — a GnuPG-compatible pair (v4 packets, Ed25519/Curve25519) that
 *             every mainstream PGP implementation can parse;
 *  - `v6`   — a modern OpenPGP v6-format pair for v6-aware clients.
 * Both public halves are published together (WKD serves them concatenated, the
 * standard multi-key form), and outbound mail is encrypted to BOTH so either
 * key can decrypt. Which is which is only a matter of what the recipient's
 * client supports — the format is signalled in the key material itself.
 */
export interface KeyPairVersion {
  publicKey: string
  privateKey: string
  fingerprint: string
}

export interface GeneratedKeySet {
  /** The v4-packet (GnuPG-compatible) keypair — primary sign + encrypt sub. */
  v4: GeneratedKey
  /** The v6-format (modern) keypair. */
  v6: GeneratedKey
}

/** What an armored public/private key says about itself, for display. */
export interface KeyInfo {
  fingerprint: string
  /** RFC 2822-style identities on the key, e.g. "Alice <a@mailstr.app>". */
  userIDs: string[]
  /** Email addresses parsed out of the user IDs, lowercased. */
  emails: string[]
  createdAt: number // unix seconds
  algorithm: string
  isPrivate: boolean
  /** True when a private key is passphrase-protected (can't sign until unlocked). */
  encrypted?: boolean
}

/**
 * The verdict on a message's signature. Deliberately not a boolean — "valid
 * math but a key we don't know" is a different claim from "signed by a key in
 * the reader's ring", and "verification FAILED" must never be confused with
 * "unsigned".
 */
export type SignatureState =
  | { status: 'valid'; keyID: string } // verified against a provided key
  | { status: 'unknown-key'; keyID: string } // signed, but no key to check it
  | { status: 'invalid'; keyID?: string } // signature present and it FAILED
  | { status: 'none' } // no signature at all

export interface DecryptResult {
  text: string
  signature: SignatureState
}

const ARMOR_MESSAGE = '-----BEGIN PGP MESSAGE-----'

/** Cheap detector for an inline-PGP body, used on the read path before decrypt. */
export function isPgpMessage(text: string): boolean {
  return text.includes(ARMOR_MESSAGE)
}

/** Generate a fresh keypair bound to one identity. */
export async function generateKey(params: {
  name?: string
  email: string
  passphrase?: string
  type?: KeyType
}): Promise<GeneratedKey> {
  const { privateKey, publicKey } = await openpgp.generateKey({
    // v6 exposes Curve25519 (Ed25519 sign + X25519 encrypt) as its own `type`,
    // no separate `curve` field. Small, fast, modern, and interoperable.
    type: params.type ?? 'curve25519',
    userIDs: [{ name: params.name, email: params.email }],
    passphrase: params.passphrase || undefined,
    format: 'armored',
  })
  const key = await openpgp.readKey({ armoredKey: publicKey })
  return { publicKey, privateKey, fingerprint: key.getFingerprint() }
}

/**
 * Generate the DUAL keypair set for one alias. Both halves carry v4 packet
 * VERSIONS (so every consumer parses them) but different ALGORITHMS, exactly
 * matching the production WKD blobs (verified against rama1@mailstr.app):
 *
 *  - `v4` half: Ed25519 legacy (algo 22) + Curve25519 ECDH (algo 18) — what
 *    GnuPG emits natively; `gpg --import` takes it clean and it's the half
 *    older mail services actually read;
 *  - `v6` half: Ed25519 (algo 27) + X25519 (algo 25) — openpgp.js's modern
 *    curve IDs, what current-generation clients prefer.
 *
 * Both are bound to the same identity, both locked (or not) with the same
 * passphrase, and BOTH public halves are published concatenated so each
 * consumer picks its supported version. Generation order is fixed.
 */
export async function generateKeySet(params: {
  name?: string
  email: string
  passphrase?: string
}): Promise<GeneratedKeySet> {
  const passphrase = params.passphrase || undefined
  const [v4, v6] = await Promise.all([
    openpgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name: params.name, email: params.email }],
      passphrase,
      format: 'armored',
      config: { v6Keys: false },
    }),
    openpgp.generateKey({
      type: 'curve25519',
      userIDs: [{ name: params.name, email: params.email }],
      passphrase,
      format: 'armored',
      config: { v6Keys: false },
    }),
  ])
  const [v4Key, v6Key] = await Promise.all([
    openpgp.readKey({ armoredKey: v4.publicKey }),
    openpgp.readKey({ armoredKey: v6.publicKey }),
  ])
  return {
    v4: {
      publicKey: v4.publicKey,
      privateKey: v4.privateKey,
      fingerprint: v4Key.getFingerprint(),
    },
    v6: {
      publicKey: v6.publicKey,
      privateKey: v6.privateKey,
      fingerprint: v6Key.getFingerprint(),
    },
  }
}

/** Read metadata off an armored key. Throws on anything that isn't a key. */
export async function readKeyInfo(armored: string): Promise<KeyInfo> {
  // A private key parses as a public key too, so try the richer read first and
  // note which it was — the UI shows a private key differently (it can sign).
  let key: openpgp.Key
  let isPrivate = false
  try {
    key = await openpgp.readPrivateKey({ armoredKey: armored })
    isPrivate = true
  } catch {
    key = await openpgp.readKey({ armoredKey: armored })
  }
  const userIDs = key.getUserIDs()
  return {
    fingerprint: key.getFingerprint(),
    userIDs,
    emails: userIDs.map(parseEmail).filter((e): e is string => !!e),
    createdAt: Math.floor(key.getCreationTime().getTime() / 1000),
    algorithm: key.getAlgorithmInfo().algorithm,
    isPrivate,
    encrypted: isPrivate ? !(key as openpgp.PrivateKey).isDecrypted() : undefined,
  }
}

/** Pull the address out of a "Name <email>" user ID (or a bare address). */
function parseEmail(userID: string): string | undefined {
  const angle = userID.match(/<([^>]+)>/)
  const raw = angle ? angle[1] : userID.includes('@') ? userID : ''
  return raw ? raw.trim().toLowerCase() : undefined
}

/** Validate an armored public key, returning its info, or throw if malformed. */
export async function validatePublicKey(armored: string): Promise<KeyInfo> {
  const info = await readKeyInfo(armored)
  return info
}

/**
 * Unlock a passphrase-protected private key. Returns the decrypted key object.
 * A wrong passphrase throws — callers surface that as "incorrect passphrase".
 */
async function decryptPrivateKey(
  armored: string,
  passphrase?: string,
): Promise<openpgp.PrivateKey> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armored })
  if (privateKey.isDecrypted()) return privateKey
  if (!passphrase) {
    throw new Error('This private key is passphrase-protected; a passphrase is required.')
  }
  return openpgp.decryptKey({ privateKey, passphrase })
}

/**
 * Re-lock a decrypted private key with a passphrase, returning the armored
 * encrypted form. The inverse of `decryptPrivateKey` — this is what backs the
 * passphrase-protected export (a downloaded key must never land on disk in
 * the clear).
 */
export async function encryptPrivateKey(
  armoredOrKey: string | openpgp.PrivateKey,
  passphrase: string,
): Promise<string> {
  const privateKey =
    typeof armoredOrKey === 'string'
      ? await openpgp.readPrivateKey({ armoredKey: armoredOrKey })
      : armoredOrKey
  const unlocked = privateKey.isDecrypted()
    ? privateKey
    : (privateKey as openpgp.PrivateKey)
  const locked = await openpgp.encryptKey({ privateKey: unlocked, passphrase })
  return typeof locked === 'string' ? locked : locked.armor()
}

/**
 * Encrypt (and by default sign) a plaintext body to one or more recipients.
 *
 * `recipientPublicKeys` should already include the sender's OWN public key so
 * the Sent copy stays readable — the caller owns that decision, this function
 * just encrypts to everything it's handed.
 */
export async function encryptMessage(params: {
  text: string
  recipientPublicKeys: string[]
  /** Sign with this armored private key. Omit to encrypt without signing. */
  signingPrivateKey?: string
  signingPassphrase?: string
}): Promise<string> {
  const encryptionKeys = await Promise.all(
    params.recipientPublicKeys.map((armoredKey) => openpgp.readKey({ armoredKey })),
  )
  const signingKeys = params.signingPrivateKey
    ? [await decryptPrivateKey(params.signingPrivateKey, params.signingPassphrase)]
    : undefined

  const message = await openpgp.createMessage({ text: params.text })
  const armored = await openpgp.encrypt({
    message,
    encryptionKeys,
    signingKeys,
    format: 'armored',
  })
  return armored as string
}

/** An armored message, parsed once so trying several own keys against it (see
 * usePgpMessage) doesn't re-parse it per attempt — and so a malformed-armor
 * failure surfaces on its own, distinguishable from "wrong key". */
export type ParsedPgpMessage = Awaited<ReturnType<typeof openpgp.readMessage>>

/** Parse armored ciphertext. Throws (e.g. "Misformed armored text") on
 * anything that isn't a well-formed PGP message — never a key mismatch, since
 * no key is involved yet. */
export async function parsePgpMessage(armored: string): Promise<ParsedPgpMessage> {
  return openpgp.readMessage({ armoredMessage: armored })
}

/**
 * Which key(s) a message's public-key-encrypted session key packets actually
 * target, as lowercase hex key IDs. A message is only decryptable by a key
 * whose own ID (primary or subkey) appears here — read this BEFORE trying any
 * key, so the read path can go straight to the one key that can actually open
 * it instead of trying every held key in turn and treating a mismatch as
 * routine.
 *
 * Empty means the message doesn't name its recipient(s) at all: purely
 * password/symmetric-encrypted, or a PGP "hidden recipient" (a wildcard key ID
 * of all zeros, sometimes used for privacy) — in either case there is no
 * target to match against, so every held key genuinely has to be tried.
 */
export function pkeskKeyIDs(message: ParsedPgpMessage): string[] {
  return message.packets
    .filterByTag(openpgp.enums.packet.publicKeyEncryptedSessionKey)
    .map((p) => (p as unknown as { publicKeyID: { toHex(): string } }).publicKeyID.toHex())
    .filter((id) => id !== '0000000000000000') // wildcard: not a real target
}

/**
 * Every key ID (primary + subkeys) an armored key — public OR private —
 * claims to be. Deliberately does NOT require a passphrase: a key ID is
 * public information carried on the unencrypted key packet, readable whether
 * or not the private material is locked, so this can run before ever asking
 * the user to unlock anything.
 */
export async function keyIDsOfArmored(armored: string): Promise<string[]> {
  const key = armored.includes('PRIVATE KEY')
    ? await openpgp.readPrivateKey({ armoredKey: armored })
    : await openpgp.readKey({ armoredKey: armored })
  return key.getKeyIDs().map((id) => id.toHex())
}

/**
 * Decrypt an already-parsed message with the user's private key, and report
 * the signature verdict against whatever verification keys the caller
 * supplies (typically the sender's key from the keyring, if held).
 */
export async function decryptMessage(params: {
  message: ParsedPgpMessage
  privateKey: string
  passphrase?: string
  /** Armored public keys to check the signature against; usually the sender's. */
  verificationPublicKeys?: string[]
}): Promise<DecryptResult> {
  const decryptionKeys = await decryptPrivateKey(params.privateKey, params.passphrase)
  const verificationKeys = await Promise.all(
    (params.verificationPublicKeys ?? []).map((armoredKey) => openpgp.readKey({ armoredKey })),
  )

  const { data, signatures } = await openpgp.decrypt({
    message: params.message,
    decryptionKeys,
    verificationKeys: verificationKeys.length ? verificationKeys : undefined,
  })

  return {
    text: typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array),
    signature: await verdictFrom(signatures, verificationKeys.length > 0),
  }
}

/**
 * Turn openpgp's signature array into one honest `SignatureState`.
 *
 * openpgp resolves `signature.verified` to a promise that REJECTS when a
 * signature is present but bad or unverifiable — so an unknown-key signature
 * and a forged one both throw, and are told apart by whether we had any key to
 * check against. No signatures at all is a clean `none`.
 */
async function verdictFrom(
  signatures: VerificationResult[],
  hadVerificationKeys: boolean,
): Promise<SignatureState> {
  if (!signatures.length) return { status: 'none' }
  const sig = signatures[0]
  const keyID = sig.keyID.toHex()
  try {
    await sig.verified
    return { status: 'valid', keyID }
  } catch {
    // Present but not verifiable: either we held no key (unknown-key) or we
    // held one and it did not match (invalid — a real warning).
    return hadVerificationKeys ? { status: 'invalid', keyID } : { status: 'unknown-key', keyID }
  }
}
