import { lazy, Suspense, useState } from "react";
import { ArrowRight } from "lucide-react";
import { config } from "../lib/config";
import { parseIdentityInput } from "../lib/nostr";

// The wizard drags in the signer + QR libraries — keep them out of the
// landing page's initial bundle.
const SignupWizard = lazy(() => import("./SignupWizard"));

/**
 * The hero's single input: npub, hex pubkey, name, or name@mailstr.app.
 * It hands off to the signup wizard, pre-filling the name when one was
 * typed; the wizard runs the NIP-05 availability check and shows the
 * status there.
 */
export default function SignupSection() {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ open: boolean; name?: string }>({
    open: false,
  });

  const check = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsed = parseIdentityInput(input);
    if (input.trim() && !parsed) {
      setError(
        "That doesn't look like an npub, a hex pubkey, or a name we can register.",
      );
      return;
    }
    // Pre-fill the wizard with the typed name; pubkey/empty just opens it.
    setWizard({ open: true, name: parsed?.kind === "name" ? parsed.name : undefined });
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
            className="inline-flex items-center gap-2 bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-light"
          >
            Claim yours <ArrowRight size={16} />
          </button>
        </div>
        <p className="mt-2 text-sm text-gray-500">
          Pick a name to see if {`name@${config.mailDomain}`} is available, or
          bring your own npub.
        </p>
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
