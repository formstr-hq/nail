/**
 * Per-account "Skip for now" memory for the one-time relay setup.
 *
 * Skipping is not the same as confirming: the user is explicitly leaving their
 * relay list alone, so it must not write a kind-10050 or even stamp the synced
 * `onboardedAt` settings flag. This local marker only stops the prompt from
 * reappearing on this device; another device will still offer the setup.
 */
const SKIP_PREFIX = 'mailstr.onboardingSkipped:'

export function markOnboardingSkipped(pubkey: string): void {
  try {
    localStorage.setItem(`${SKIP_PREFIX}${pubkey}`, '1')
  } catch {
    // Storage unavailable — the prompt may reappear, which is safer than
    // silently writing to the network just to remember a skip.
  }
}

export function isOnboardingSkipped(pubkey: string): boolean {
  try {
    return localStorage.getItem(`${SKIP_PREFIX}${pubkey}`) === '1'
  } catch {
    return false
  }
}
