import { useCallback, useEffect, useRef, useState } from "react";
import { AtSign, Check, Loader2, PartyPopper, X } from "lucide-react";
import { renderLoginHtml, attachLoginListeners } from "@formstr/signer/ui";
import "@formstr/signer/styles.css";
import { signer, pool, NOSTRCONNECT_RELAYS } from "../lib/signer";

/*
 * The login-UI helpers below (TAB_COPY, tuneLoginUi, methodListNav,
 * autoGenerateQr) are intentionally duplicated in
 * client/src/components/LoginPage.tsx. landing/ and client/ are independent
 * builds — no pnpm workspace, React 19 vs 18, and per-app Docker build
 * contexts — so a cross-app import compiles in dev but breaks
 * `docker compose build` (the sibling directory is outside the context).
 * Future direction: move this DOM tuning upstream into @formstr/signer as
 * config/slots so both apps consume it from the package they already share.
 */

/** Copy + lucide icon shapes for the method picker rows, keyed by tab id. */
const TAB_COPY: Record<string, { title: string; desc: string; icon: string }> =
  {
    create: {
      title: "Create a new account",
      desc: "Fresh key, protected by a passphrase",
      icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    },
    extension: {
      title: "Browser extension",
      desc: "Alby, nos2x, or any NIP-07 signer",
      icon: '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
    },
    ncryptsec: {
      title: "Existing key",
      desc: "Sign in with an ncryptsec backup",
      icon: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
    },
    bunker: {
      title: "Nostr bunker",
      desc: "Connect with a bunker:// URI",
      icon: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/><path d="m7.9 7.9 2.7 2.7"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/><path d="m13.4 10.6 2.7-2.7"/><circle cx="7.5" cy="16.5" r=".5" fill="currentColor"/><path d="m7.9 16.1 2.7-2.7"/><circle cx="16.5" cy="16.5" r=".5" fill="currentColor"/><path d="m13.4 13.4 2.7 2.7"/><circle cx="12" cy="12" r="2"/>',
    },
    nostrconnect: {
      title: "Remote signer (QR)",
      desc: "Scan with your signer app",
      icon: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
    },
  };

/** Order of the "already have a key?" rows under the create card. */
const SECONDARY_TABS = ["extension", "ncryptsec", "bunker", "nostrconnect"];

const ICON_SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

/**
 * Trim the stock login markup down to what makes sense on the web:
 * no Android (NIP-55 needs a native plugin), no relay/permission
 * power-user fields — Remote (QR) goes straight to a QR code on
 * the default relays. The tab row is rebuilt into a method picker:
 * the create tab becomes the primary card and the rest get icon
 * rows under an "already have an identity?" divider (the wizard
 * card supplies the heading, so no brand header here).
 */
function tuneLoginUi(el: HTMLElement) {
  el.querySelector('[data-tab="android"]')?.remove();
  el.querySelector('[data-panel="android"]')?.remove();
  const relaysInput = el.querySelector<HTMLInputElement>(
    ".nostr-signer__input--relays",
  );
  if (relaysInput) relaysInput.value = NOSTRCONNECT_RELAYS.join(", ");

  el.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((tab) => {
    const copy = TAB_COPY[tab.dataset.tab ?? ""];
    if (!copy) return;
    const icon = document.createElement("span");
    icon.className = "nostr-signer__tab-icon";
    icon.innerHTML = ICON_SVG_OPEN + copy.icon + "</svg>";
    const title = document.createElement("span");
    title.className = "nostr-signer__tab-title";
    title.textContent = copy.title;
    const desc = document.createElement("span");
    desc.className = "nostr-signer__tab-desc";
    desc.textContent = copy.desc;
    const text = document.createElement("span");
    text.className = "nostr-signer__tab-text";
    text.append(title, desc);
    tab.replaceChildren(icon, text);
  });

  const tabs = el.querySelector<HTMLElement>(".nostr-signer__tabs");
  if (tabs) {
    const divider = document.createElement("div");
    divider.className = "nostr-signer__tabs-label";
    divider.setAttribute("aria-hidden", "true");
    divider.textContent = "Already have a key?";
    tabs.append(divider);
    for (const id of SECONDARY_TABS) {
      const btn = tabs.querySelector(`[data-tab="${id}"]`);
      if (btn) tabs.append(btn);
    }
  }
}

/**
 * Two-step navigation: a picker list of sign-in methods first, then the
 * chosen method's panel with a back link. The tab row doubles as the
 * list (index.css shows one or the other via the --picker modal class);
 * the package's own tab→panel switching keeps running underneath.
 */
function methodListNav(el: HTMLElement): () => void {
  const modal = el.querySelector<HTMLElement>(".nostr-signer__modal");
  const body = el.querySelector<HTMLElement>(".nostr-signer__body");
  if (!modal || !body) return () => {};
  const back = document.createElement("button");
  back.type = "button";
  back.className = "nostr-signer__back";
  back.textContent = "← All sign-in options";
  body.prepend(back);
  modal.classList.add("nostr-signer__modal--picker");
  const showPanel = () => modal.classList.remove("nostr-signer__modal--picker");
  const showPicker = () => {
    // The freshly-created ncryptsec backup must be acknowledged before any
    // navigation — the CSS :has() rule only hides the button, so refuse here.
    const created = el.querySelector<HTMLElement>('[data-panel="created"]');
    if (created && !created.hidden) return;
    modal.classList.add("nostr-signer__modal--picker");
  };
  const tabs = Array.from(el.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  tabs.forEach((tab) => tab.addEventListener("click", showPanel));
  back.addEventListener("click", showPicker);
  return () => {
    tabs.forEach((tab) => tab.removeEventListener("click", showPanel));
    back.removeEventListener("click", showPicker);
  };
}

/** Auto-generate the nostrconnect QR when the Remote (QR) tab opens. */
function autoGenerateQr(el: HTMLElement): () => void {
  const tab = el.querySelector<HTMLButtonElement>('[data-tab="nostrconnect"]');
  const qr = el.querySelector<HTMLElement>('[data-region="nostrconnect-qr"]');
  const form = el.querySelector<HTMLFormElement>('[data-form="nostrconnect"]');
  const onClick = () => {
    if (qr?.hidden) form?.requestSubmit();
  };
  tab?.addEventListener("click", onClick);
  return () => tab?.removeEventListener("click", onClick);
}
import { config } from "../lib/config";
import {
  apiUrl,
  generateMailInvoice,
  getMailTiers,
  ownsMailbox,
  resolveNip05,
  type MailInvoice,
  type MailTier,
} from "../lib/api";
import { isValidLocalPart } from "../lib/nostr";
import { buildNip98Header } from "../lib/nip98";
import { redirectToMails, unlockWithTimeout } from "../lib/session";
import InvoiceQR from "./InvoiceQR";

type Step = "login" | "resolving" | "name" | "pay" | "done";
type Availability =
  | "idle"
  | "checking"
  | "free"
  | "taken"
  | "invalid"
  | "error";

// A key created here provably has no kind-10050 relay list yet. The mail app
// (same origin: mailstr.app + /mails) reads this flag after the redirect so its
// relay onboarding can trust "no list" without waiting on relay reachability.
// Same string as client/src/lib/freshSignup.ts — duplicated because landing and
// client are separate builds.
const FRESH_SIGNUP_KEY = "mailstr.freshSignup";

export default function SignupWizard({
  initialName,
  onClose,
  purchaseMode = false,
}: {
  /** Name the user typed in the hero input, if it was a name. */
  initialName?: string;
  onClose: () => void;
  /**
   * Set when the mail client sends an existing owner here to buy an
   * *additional* address. Skips the "already owns a mailbox → bounce to the
   * inbox" shortcut so a returning owner reaches address selection instead of
   * being redirected straight back where they came from.
   */
  purchaseMode?: boolean;
}) {
  const [step, setStep] = useState<Step>("login");
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [name, setName] = useState(initialName ?? "");
  const [nameCheck, setNameCheck] = useState<{
    name: string;
    taken: boolean;
  } | null>(null);
  // The name whose availability check failed, plus a nonce the Retry button
  // bumps to re-run it. Without this a flaky lookup leaves the field stuck on
  // "Checking…" forever with "Claim it" permanently disabled — a dead end.
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  const [checkNonce, setCheckNonce] = useState(0);
  const [tiers, setTiers] = useState<MailTier[] | null>(null);
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<MailInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loginRef = useRef<HTMLDivElement>(null);

  const proceedAs = useCallback(async (pk: string) => {
    setPubkey(pk);
    // A returning paying user shouldn't be asked to pick an address again — if
    // they already own a mailbox, send them straight to the app. Bounded so a
    // slow signer/lookup can't strand them: any error or timeout falls through
    // to the normal signup. Skipped in purchaseMode, where an existing owner
    // has come here deliberately to claim another address.
    const active = signer.getActiveSigner();
    if (!purchaseMode && active) {
      setStep("resolving");
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
            setTimeout(() => reject(new Error("timeout")), 6000),
          ),
        ]);
        if (owns) {
          redirectToMails();
          return;
        }
      } catch {
        // fall through to signup
      }
    }
    setStep("name");
  }, [purchaseMode]);

  /* Step 1 — sign in. Silent resume when a previous session exists,
     otherwise the @formstr/signer login UI (NIP-07/46/49/55). */
  useEffect(() => {
    if (step !== "login") return;
    let cancelled = false;
    let detach: (() => void) | undefined;

    (async () => {
      try {
        const resumed = await unlockWithTimeout();
        if (cancelled) return;
        if (resumed) {
          const account = signer.getActiveAccount();
          if (account) {
            await proceedAs(account.pubkey);
            return;
          }
        }
      } catch {
        // fall through to the login UI
      }
      const el = loginRef.current;
      if (!el || cancelled) return;
      el.innerHTML = renderLoginHtml();
      tuneLoginUi(el);
      const binding = attachLoginListeners(el, signer, {
        pool,
        onLogin: () => {
          const account = signer.getActiveAccount();
          if (account) void proceedAs(account.pubkey);
        },
        onError: (err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)),
      });
      const detachQr = autoGenerateQr(el);
      const detachNav = methodListNav(el);
      // Flag a freshly-created key for the mail app's relay onboarding. Capture
      // phase on the container runs before the package's created-ack handler
      // fires onLogin, so the flag is set before the redirect. Only the create
      // path clicks created-ack, so imported keys are never marked.
      const markCreated = (e: Event) => {
        if ((e.target as HTMLElement | null)?.closest('[data-action="created-ack"]')) {
          const pk = signer.getActiveAccount()?.pubkey;
          if (pk) {
            try {
              localStorage.setItem(FRESH_SIGNUP_KEY, pk);
            } catch {
              // storage unavailable — onboarding falls back to reachability
            }
          }
        }
      };
      el.addEventListener("click", markCreated, true);
      detach = () => {
        detachNav();
        detachQr();
        el.removeEventListener("click", markCreated, true);
        binding.detach();
      };
    })();

    return () => {
      cancelled = true;
      detach?.();
    };
  }, [step, proceedAs]);

  /* Step 2 — debounced availability check on the chosen name.
     `availability` is derived: while the latest result doesn't match the
     current input, we're still checking. */
  useEffect(() => {
    if (step !== "name" || !name || !isValidLocalPart(name)) return;
    const t = setTimeout(async () => {
      try {
        const owner = await resolveNip05(name);
        setNameCheck({ name, taken: owner !== null });
        setCheckFailed(null);
      } catch {
        // Surface a retryable inline error instead of a permanent "Checking…".
        setCheckFailed(name);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [step, name, checkNonce]);

  const availability: Availability = !name
    ? "idle"
    : !isValidLocalPart(name)
      ? "invalid"
      : checkFailed === name
        ? "error"
        : nameCheck?.name === name
          ? nameCheck.taken
            ? "taken"
            : "free"
          : "checking";

  useEffect(() => {
    if (step !== "name" || tiers !== null) return;
    getMailTiers()
      .then((list) => {
        setTiers(list);
        // Default the selection to the first purchasable tier.
        setSelectedTierId((prev) => prev ?? list.find((t) => t.available)?.id ?? null);
      })
      .catch(() => setTiers(null));
  }, [step, tiers]);

  const selectedTier = tiers?.find((t) => t.id === selectedTierId) ?? null;

  /* Step 2 → 3 — NIP-98-signed invoice request. */
  const requestInvoice = async () => {
    const active = signer.getActiveSigner();
    if (!pubkey || !active) {
      setError("Your session is locked — sign in again.");
      setStep("login");
      return;
    }
    if (!selectedTier) {
      setError("Pick a plan first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // tierId is part of the signed body, so the backend prices by the chosen
      // tier and the NIP-98 payload digest still matches what's sent.
      const body = {
        pubkey,
        nip05: `${name}@${config.mailDomain}`,
        tierId: selectedTier.id,
      };
      const url = apiUrl("/api/generate-invoice/mail");
      const header = await buildNip98Header(
        active,
        url,
        "POST",
        JSON.stringify(body),
      );
      const inv = await generateMailInvoice(header, body);
      setInvoice(inv);
      setStep("pay");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invoice request failed");
    } finally {
      setBusy(false);
    }
  };

  const onPaid = () => {
    setStep("done");
    setTimeout(redirectToMails, 2500);
  };

  const address = `${name || "you"}@${config.mailDomain}`;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm"
      onClick={step === "pay" ? undefined : onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-black/10 bg-paper p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-ink">
              {step === "login" && "Sign in with your Nostr key"}
              {step === "resolving" && "One moment…"}
              {step === "name" && "Pick your address"}
              {step === "pay" && "One payment, and it's yours"}
              {step === "done" && "Welcome to Mail by Formstr"}
            </h3>
            <p className="mt-0.5 text-sm text-gray-500">
              {step === "login" &&
                "Your key is your account. New to Nostr? Create one below."}
              {step === "resolving" && "Checking your account"}
              {step === "name" && "This becomes your email and your NIP-05 handle."}
              {step === "pay" && `Claiming ${address}`}
              {step === "done" && "Taking you to your inbox…"}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-black/[0.05] hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {step === "login" && <div ref={loginRef} className="signer-embed" />}

        {step === "resolving" && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <span className="relative flex h-10 w-10 items-center justify-center">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/20" />
              <Loader2 size={24} className="animate-spin text-primary" />
            </span>
            <p className="text-sm text-gray-500">Checking your account…</p>
          </div>
        )}

        {step === "name" && (
          <div>
            <label className="mb-1.5 block text-sm font-semibold text-ink">
              Your address
            </label>
            <div className="flex items-stretch overflow-hidden rounded-xl border border-black/15 bg-white focus-within:border-primary">
              <span className="flex items-center pl-3 text-gray-400">
                <AtSign size={15} />
              </span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().trim())}
                placeholder="you"
                className="min-w-0 flex-1 bg-transparent px-2 py-3 text-sm text-ink outline-none"
              />
              <span className="flex items-center border-l border-black/5 bg-black/[0.03] px-3 font-mono text-sm text-gray-500">
                @{config.mailDomain}
              </span>
            </div>

            <p className="mt-2 min-h-5 text-sm">
              {availability === "checking" && (
                <span className="inline-flex items-center gap-1.5 text-gray-400">
                  <Loader2 size={13} className="animate-spin" /> Checking…
                </span>
              )}
              {availability === "free" && (
                <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-600">
                  <Check size={14} /> {address} is available
                </span>
              )}
              {availability === "taken" && (
                <span className="font-semibold text-red-600">
                  {address} is taken — try another
                </span>
              )}
              {availability === "invalid" && (
                <span className="text-gray-500">
                  Lowercase letters, digits, dots, underscores and hyphens only.
                </span>
              )}
              {availability === "error" && (
                <span className="inline-flex items-center gap-2 text-gray-500">
                  Couldn't check availability.
                  <button
                    type="button"
                    onClick={() => {
                      setCheckFailed(null);
                      setCheckNonce((n) => n + 1);
                    }}
                    className="font-semibold text-primary underline"
                  >
                    Retry
                  </button>
                </span>
              )}
            </p>

            {/* Plans come from the backend (see getMailTiers). Each is its own
                card listing what's included (✓) and not (✗); a not-yet-sellable
                tier is shown greyed with a "coming soon" badge. */}
            <div className="mt-4 flex flex-col gap-2">
              {tiers === null ? (
                <div className="flex items-center justify-center rounded-xl border border-black/10 bg-white p-6">
                  <Loader2 size={18} className="animate-spin text-gray-300" />
                </div>
              ) : (
                tiers.map((t) => {
                  const selected = t.id === selectedTierId;
                  return (
                    <div
                      key={t.id}
                      role="radio"
                      aria-checked={selected}
                      aria-disabled={!t.available}
                      tabIndex={t.available ? 0 : -1}
                      onClick={() => t.available && setSelectedTierId(t.id)}
                      onKeyDown={(e) => {
                        if (t.available && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          setSelectedTierId(t.id);
                        }
                      }}
                      className={[
                        "rounded-xl border p-4 text-left transition-colors",
                        t.available
                          ? "cursor-pointer"
                          : "cursor-default opacity-60",
                        selected
                          ? "border-primary bg-white ring-1 ring-primary"
                          : "border-black/10 bg-white hover:border-black/20",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="text-base font-bold text-ink">{t.name}</h4>
                            {!t.available && (
                              <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                                Coming soon
                              </span>
                            )}
                          </div>
                          {t.description && (
                            <p className="mt-0.5 text-xs text-gray-500">{t.description}</p>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <span className="text-lg font-bold leading-none text-ink">
                            {t.priceSats.toLocaleString()}
                          </span>
                          <span className="ml-1 text-sm text-gray-500">sats</span>
                          <span className="block text-[11px] text-gray-400">one-time</span>
                        </div>
                      </div>
                      {(t.features.length > 0 || t.notIncluded.length > 0) && (
                        <ul className="mt-3 flex flex-col gap-1.5 text-sm">
                          {t.features.map((f) => (
                            <li key={f} className="flex items-center gap-2 text-gray-600">
                              <Check size={15} className="shrink-0 text-emerald-600" />
                              <span>{f}</span>
                            </li>
                          ))}
                          {t.notIncluded.map((f) => (
                            <li key={f} className="flex items-center gap-2 text-gray-400">
                              <X size={15} className="shrink-0" />
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <button
              disabled={availability !== "free" || busy || !selectedTier}
              onClick={requestInvoice}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white transition-all enabled:hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? (
                <>
                  <Loader2 size={15} className="animate-spin" /> Preparing invoice…
                </>
              ) : (
                <>
                  Get {selectedTier?.name ?? "Mail"}
                  {selectedTier ? ` — ${selectedTier.priceSats.toLocaleString()} sats` : ""}
                </>
              )}
            </button>
            <p className="mt-2 text-center text-xs text-gray-400">
              Paid once over Lightning. No card, no recurring charge.
            </p>
          </div>
        )}

        {step === "pay" && invoice && (
          <InvoiceQR
            invoice={invoice.invoice}
            hash={invoice.paymentHash}
            amount={invoice.amount}
            onPaid={onPaid}
          />
        )}

        {step === "done" && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <PartyPopper size={40} className="text-primary" />
            <p className="text-lg font-bold text-ink">{address} is yours.</p>
            <p className="text-sm text-gray-500">
              Mail sent there now arrives encrypted to your key.{" "}
              <a href={config.mailsUrl} className="font-semibold text-primary">
                Open your inbox →
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
