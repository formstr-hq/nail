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

/**
 * Decrypt an armored message with the user's private key, and report the
 * signature verdict against whatever verification keys the caller supplies
 * (typically the sender's key from the keyring, if held).
 */
export async function decryptMessage(params: {
  armored: string
  privateKey: string
  passphrase?: string
  /** Armored public keys to check the signature against; usually the sender's. */
  verificationPublicKeys?: string[]
}): Promise<DecryptResult> {
  const decryptionKeys = await decryptPrivateKey(params.privateKey, params.passphrase)
  const verificationKeys = await Promise.all(
    (params.verificationPublicKeys ?? []).map((armoredKey) => openpgp.readKey({ armoredKey })),
  )

  const message = await openpgp.readMessage({ armoredMessage: params.armored })
  const { data, signatures } = await openpgp.decrypt({
    message,
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
