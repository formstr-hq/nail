/**
 * The unlocked-passphrase cache, for the session only.
 *
 * A passphrase-protected private key would otherwise prompt on every decrypt
 * and every signed send. Holding the passphrase in memory for the tab's
 * lifetime is the usual desktop-mail bargain: unlock once, stay unlocked until
 * you close it. It is never persisted — a reload asks again — so it never
 * touches disk, storage, or the settings blob.
 */
let cachedPassphrase: string | null = null

export function setSessionPassphrase(passphrase: string): void {
  cachedPassphrase = passphrase
}

export function getSessionPassphrase(): string | null {
  return cachedPassphrase
}

export function clearSessionPassphrase(): void {
  cachedPassphrase = null
}
