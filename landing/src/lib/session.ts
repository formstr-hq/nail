import { signer, pool } from "./signer";
import { config } from "./config";
import { apiUrl, ownsMailbox } from "./api";
import { buildNip98Header } from "./nip98";

/**
 * A silent resume must never be able to hang the caller. `signer.unlock`
 * talks to relays for NIP-46 sessions and has no timeout of its own, so on a
 * flaky/hardened network a slow resume could leave the page stuck. Race it
 * against a deadline and treat a timeout as "no resume".
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

export function redirectToMails() {
  window.location.href = config.mailsUrl;
}

/**
 * Whether the URL carries an explicit `?buy=1` intent. The mail client links
 * existing owners here to buy an *additional* address, so this visit must NOT
 * be bounced straight back to the inbox by the returning-user auto-redirect
 * below — otherwise the two redirects ping-pong and the buy screen is
 * unreachable.
 */
export function hasBuyIntent(
  search = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  if (new URLSearchParams(search).get("buy") === "1") return true;
  // Fallback for contexts where the `?buy=1` query didn't survive — notably the
  // Android webview opening the client's Buy link in a fresh window, where the
  // query can be dropped and the landing loads with no intent. The client
  // stashes the same intent in shared same-origin storage right before
  // navigating here, so the wizard still opens in purchase mode (and never
  // bounces an owner to their inbox on sign-in). Consumed by clearBuyIntent()
  // once the wizard mounts, so it can't leak into a later organic visit.
  try {
    return typeof window !== "undefined" && localStorage.getItem(BUY_INTENT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Consume the stashed buy intent once it has opened the wizard. */
export function clearBuyIntent(): void {
  try {
    localStorage.removeItem(BUY_INTENT_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}

const BUY_INTENT_KEY = "mailstr.buyIntent";

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
 * On a plain visit, a returning user who already owns a mailbox is sent
 * straight to the inbox instead of being shown the signup hero again. This is
 * the page-level auto-redirect: it runs on mount, independent of the signup
 * wizard (which only mounts once "Claim yours" is clicked — so before this,
 * owners who just opened the page were never redirected).
 *
 * Every failure path resolves to "no redirect": a hiccup must never strand a
 * visitor on a blank page. Resolves `true` only when a redirect was triggered.
 */
export async function redirectReturningOwner(): Promise<boolean> {
  const resumed = await unlockWithTimeout().catch(() => null);
  if (!resumed) return false;
  const active = signer.getActiveSigner();
  if (!active) return false;
  try {
    const owns = await Promise.race([
      (async () => {
        const header = await buildNip98Header(
          active,
          apiUrl("/api/nip-05/get-nip05"),
          "GET",
        );
        return ownsMailbox(header);
      })(),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), RESUME_TIMEOUT_MS),
      ),
    ]);
    if (owns) {
      redirectToMails();
      return true;
    }
  } catch {
    // fall through — show the landing page
  }
  return false;
}
