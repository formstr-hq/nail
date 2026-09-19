/**
 * The unlocked-passphrase cache, for the session only.
 *
 * Kept for LEGACY keys: Mailstr no longer generates or stores
 * passphrase-protected keys (they are unlocked, so encrypt/sign/decrypt need
 * no unlock step), but a key created before that policy change may still be
 * locked, and its mail must stay readable. A locked legacy key would otherwise
 * prompt on every decrypt and every signed send, so its passphrase is held in
 * memory for the tab's lifetime — the usual desktop-mail bargain: unlock once,
 * stay unlocked until you close it. It is never persisted — a reload asks
 * again — so it never touches disk, storage, or the settings blob.
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