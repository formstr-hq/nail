import { signer, pool } from "./signer";
import { config } from "./config";

/**
 * A silent resume must never be able to hang the caller. `signer.unlock`
 * talks to relays for NIP-46 sessions and has no timeout of its own, so on a
 * flaky/hardened network a slow resume could leave the page stuck. Race it
 * against a deadline and treat a timeout as "no resume".
 *
 * Note: the client's PGP passphrase session cache (a different "session")
 * lives in the ported client code under app/ from Phase 2, not here.
 */
const RESUME_TIMEOUT_MS = 6000;

export function unlockWithTimeout(): Promise<
  Awaited<ReturnType<typeof signer.unlock>> | null
> {
  return Promise.race([
    signer.unlock({ pool }),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), RESUME_TIMEOUT_MS),
    ),
  ]);
}

export function redirectToMails(params?: Record<string, string>) {
  const url = new URL(config.mailsUrl, window.location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  window.location.href = url.toString();
}

/**
 * Whether the URL carries an explicit `?buy=1` intent. The landing's wizard
 * opens in purchase mode on such a visit (an existing owner claiming an
 * *additional* address), so this visit must NOT be bounced straight back to
 * the inbox by the returning-user auto-redirect below — otherwise the two
 * redirects ping-pong and the buy screen is unreachable.
 *
   * The mail client's buy flow is now an in-app overlay (store/buyOverlay) and
   * no longer navigates here, so the `mailstr.buyIntent` storage fallback that
   * papered over the Android webview dropping query strings has no writer and
   * was removed with it.
 */
export function hasBuyIntent(
  search = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  return new URLSearchParams(search).get("buy") === "1";
}

const REF_KEY = "mailstr.ref";
const REF_AT_KEY = "mailstr.refAt";
const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30-day attribution window

/**
 * Capture a `?ref=CODE` affiliate token on the landing. Stored with a timestamp
 * so the backend can enforce the attribution window; last-touch wins. Called
 * once on mount (see Home). No-op when the URL carries no ref.
 */
export function captureRef(
  search = typeof window !== "undefined" ? window.location.search : "",
): void {
  const ref = new URLSearchParams(search).get("ref");
  if (!ref || !ref.trim()) return;
  try {
    localStorage.setItem(REF_KEY, ref.trim());
    localStorage.setItem(REF_AT_KEY, String(Date.now()));
  } catch {
    // storage unavailable — referral simply won't attribute
  }
}

/**
 * The referral token to send with a purchase, if one was captured within the
 * 30-day window. Expired tokens are cleared.
 */
export function getRef(): string | null {
  try {
    const ref = localStorage.getItem(REF_KEY);
    if (!ref) return null;
    const at = Number(localStorage.getItem(REF_AT_KEY) ?? 0);
    if (!at || Date.now() - at > REF_TTL_MS) {
      clearRef();
      return null;
    }
    return ref;
  } catch {
    return null;
  }
}

export function clearRef(): void {
  try {
    localStorage.removeItem(REF_KEY);
    localStorage.removeItem(REF_AT_KEY);
  } catch {
    // ignore
  }
}

/**
 * Synchronous: is there a persisted account a silent resume could unlock?
 * Only a returning visitor has one. We check this *before paint* to decide
 * whether to show the "checking…" screen — so an owner we're about to
 * redirect never sees a flash of the signup hero, while a brand-new visitor
 * (no account) is shown the landing page immediately with no needless spinner.
 */
export function hasResumableSession(): boolean {
  try {
    return signer.getActiveAccount() != null;
  } catch {
    return false;
  }
}

/**
 * On a plain visit, a returning user with a persisted account is sent straight
 * to the inbox instead of being shown the signup hero again. This is the
 * page-level auto-redirect: it runs on mount, independent of the signup
 * wizard (which only mounts once "Claim yours" is clicked).
 *
 * Any persisted account counts — including a locked ncryptsec one, which has
 * no silent unlock (the passphrase is never persisted) and which the mail app's
 * own login page prompts for. Trying to verify mailbox ownership here first
 * would need the signer plus an API round-trip and only delayed the redirect,
 * so the landing never does that work: /mails owns re-auth and onboarding.
 *
 * Resolves `true` only when a redirect was triggered.
 */
export async function redirectReturningOwner(): Promise<boolean> {
  if (!hasResumableSession()) return false;
  redirectToMails();
  return true;
}
