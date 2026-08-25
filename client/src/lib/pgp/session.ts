/**
 * The unlocked-passphrase cache, for the session only.
 *
 * A passphrase-protected private key would otherwise prompt on every decrypt
 * and every signed send. Holding the passphrase in memory for the tab's
 * lifetime is the usual desktop-mail bargain: unlock once, stay unlocked until
 * you close it. It is never persisted — a reload asks again — so it never
 * touches disk, storage, or the settings blob.
 *
 * Keyed by key FINGERPRINT: with per-alias keys the user may have several
 * distinct passphrases, so unlocking one alias must not be mistaken for having
 * unlocked another.
 */
const cache = new Map<string, string>()

export function setSessionPassphrase(fingerprint: string, passphrase: string): void {
  cache.set(fingerprint, passphrase)
}

export function getSessionPassphrase(fingerprint: string): string | null {
  return cache.get(fingerprint) ?? null
}

export function clearSessionPassphrases(): void {
  cache.clear()
}
