import { lazy, Suspense, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { config } from "../lib/config";
import { resolveNip05 } from "../lib/api";
import { parseIdentityInput } from "../lib/nostr";

// The wizard drags in the signer + QR libraries — keep them out of the
// landing page's initial bundle.
const SignupWizard = lazy(() => import("./SignupWizard"));

/**
 * The hero's single input: npub, hex pubkey, name, or name@mailstr.app.
 * A free name (or a pubkey/empty input) opens the signup wizard; a name
 * that's already registered just reports that it's taken. Availability is
 * a NIP-05 well-known lookup — no backend call.
 */
export default function SignupSection() {
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ open: boolean; name?: string }>({
    open: false,
  });

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setTaken(null);

    const parsed = parseIdentityInput(input);
    if (input.trim() && !parsed) {
      setError(
        "That doesn't look like an npub, a hex pubkey, or a name we can register.",
      );
      return;
    }
    // Empty input or a pubkey → straight into the wizard; they'll pick a
    // name there.
    if (!parsed || parsed.kind === "pubkey") {
      setWizard({ open: true });
      return;
    }

    setChecking(true);
    try {
      const owner = await resolveNip05(parsed.name);
      if (owner) {
        setTaken(`${parsed.name}@${config.mailDomain}`);
        return;
      }
      setWizard({ open: true, name: parsed.name }); // name is free — pre-fill it
    } catch {
      setError("Couldn't check availability — try again in a moment.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <form onSubmit={check} className="mt-8 max-w-xl">
        <div className="flex items-stretch overflow-hidden rounded-xl border border-ink/15 bg-white shadow-sm focus-within:border-primary">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="npub… or pick a name"
            aria-label="Your npub, pubkey, or desired name"
            className="min-w-0 flex-1 bg-transparent px-4 py-3.5 text-sm text-ink outline-none placeholder:text-gray-400"
          />
          <button
            type="submit"
            disabled={checking}
            className="inline-flex items-center gap-2 bg-primary px-5 text-sm font-semibold text-white transition-colors enabled:hover:bg-primary-light disabled:opacity-60"
          >
            {checking ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <>
                Claim yours <ArrowRight size={16} />
              </>
            )}
          </button>
        </div>
        <p className="mt-2 text-sm text-gray-500">
          Pick a name to see if {`name@${config.mailDomain}`} is available, or
          bring your own npub.
        </p>
        {taken && (
          <p className="mt-2 text-sm font-medium text-red-600">
            {taken} is already taken — try another name.
          </p>
        )}
        {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
      </form>

      {wizard.open && (
        <Suspense fallback={null}>
          <SignupWizard
            initialName={wizard.name}
            onClose={() => setWizard({ open: false })}
          />
        </Suspense>
      )}
    </>
  );
}
