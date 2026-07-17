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
  getMailbox,
  getMailPrice,
  resolveNip05,
  type MailInvoice,
} from "../lib/api";
import { isValidLocalPart } from "../lib/nostr";
import { buildNip98Header } from "../lib/nip98";
import InvoiceQR from "./InvoiceQR";

type Step = "login" | "name" | "pay" | "done";
type Availability = "idle" | "checking" | "free" | "taken" | "invalid";

function redirectToMails() {
  window.location.href = config.mailsUrl;
}

export default function SignupWizard({
  initialName,
  onClose,
}: {
  /** Name the user typed in the hero input, if it was a name. */
  initialName?: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("login");
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [name, setName] = useState(initialName ?? "");
  const [nameCheck, setNameCheck] = useState<{
    name: string;
    taken: boolean;
  } | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [invoice, setInvoice] = useState<MailInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loginRef = useRef<HTMLDivElement>(null);

  // Once we know who the user is: existing mailbox → straight to the app.
  const proceedAs = useCallback(async (pk: string) => {
    setPubkey(pk);
    try {
      const mailbox = await getMailbox(pk);
      if (mailbox) {
        redirectToMails();
        return;
      }
    } catch {
      // backend unreachable for the check — let signup continue; the
      // invoice request will surface a real error if something is wrong
    }
    setStep("name");
  }, []);

  /* Step 1 — sign in. Silent resume when a previous session exists,
     otherwise the @formstr/signer login UI (NIP-07/46/49/55). */
  useEffect(() => {
    if (step !== "login") return;
    let cancelled = false;
    let detach: (() => void) | undefined;

    (async () => {
      try {
        const resumed = await signer.unlock({ pool });
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
      detach = () => {
        detachNav();
        detachQr();
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
      } catch {
        setError("Couldn't check availability — is the network up?");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [step, name]);

  const availability: Availability = !name
    ? "idle"
    : !isValidLocalPart(name)
      ? "invalid"
      : nameCheck?.name === name
        ? nameCheck.taken
          ? "taken"
          : "free"
        : "checking";

  useEffect(() => {
    if (step !== "name" || price !== null) return;
    getMailPrice()
      .then(setPrice)
      .catch(() => setPrice(null));
  }, [step, price]);

  /* Step 2 → 3 — NIP-98-signed invoice request. */
  const requestInvoice = async () => {
    const active = signer.getActiveSigner();
    if (!pubkey || !active) {
      setError("Your session is locked — sign in again.");
      setStep("login");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = { pubkey, nip05: `${name}@${config.mailDomain}` };
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
              {step === "name" && "Pick your address"}
              {step === "pay" && "One payment, and it's yours"}
              {step === "done" && "Welcome to Mailstr"}
            </h3>
            <p className="mt-0.5 text-sm text-gray-500">
              {step === "login" &&
                "Your key is your account. New to Nostr? Create one below."}
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
            </p>

            <button
              disabled={availability !== "free" || busy}
              onClick={requestInvoice}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white transition-all enabled:hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? (
                <>
                  <Loader2 size={15} className="animate-spin" /> Preparing invoice…
                </>
              ) : (
                <>Claim it{price !== null ? ` — ${price} sats` : ""}</>
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
