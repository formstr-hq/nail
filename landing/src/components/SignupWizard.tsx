import { useCallback, useEffect, useRef, useState } from "react";
import { AtSign, Check, Loader2, PartyPopper, X } from "lucide-react";
import { renderLoginHtml, attachLoginListeners } from "@formstr/signer/ui";
import "@formstr/signer/styles.css";
import { signer } from "../lib/signer";
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
        const resumed = await signer.unlock({});
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
      const binding = attachLoginListeners(el, signer, {
        onLogin: () => {
          const account = signer.getActiveAccount();
          if (account) void proceedAs(account.pubkey);
        },
        onError: (err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)),
      });
      detach = () => binding.detach();
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

        {step === "login" && <div ref={loginRef} />}

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
