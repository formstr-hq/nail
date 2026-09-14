// A brand-new key created through our own login UI provably has no relay list
// (kind 10050) anywhere yet. We record that fact — keyed by pubkey — so the
// one-time relay onboarding can trust "no list" even when relays are momentarily
// unreachable, without risking overwriting an existing list on an *imported*
// key (which may already have a 10050 elsewhere).
//
// The landing signup wizard writes the SAME key on the SAME origin (mailstr.app
// and /mails). It lives in this app at components/SignupWizard.tsx, but the key
// is a shared contract with it and with the mail client, so the literal is
// pinned here rather than imported.
const FRESH_SIGNUP_KEY = 'mailstr.freshSignup'

/** Record that `pubkey` was just created here (or on the landing). */
export function markFreshSignup(pubkey: string): void {
  try {
    localStorage.setItem(FRESH_SIGNUP_KEY, pubkey)
  } catch {
    // Storage unavailable — onboarding falls back to the relay-reachability
    // check, which is correct, just less certain for a brand-new key.
  }
}

/** Was `pubkey` created here and not yet through onboarding? */
export function isFreshSignup(pubkey: string): boolean {
  try {
    return localStorage.getItem(FRESH_SIGNUP_KEY) === pubkey
  } catch {
    return false
  }
}

/** Consume the flag once onboarding is done, so it never applies twice. */
export function clearFreshSignup(): void {
  try {
    localStorage.removeItem(FRESH_SIGNUP_KEY)
  } catch {
    // ignore — already gone or storage unavailable
  }
}
