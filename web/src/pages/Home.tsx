import { useLayoutEffect, useEffect, useState } from "react";
import {
  AtSign,
  KeyRound,
  Loader2,
  Lock,
  Radio,
} from "lucide-react";
import { config } from "@/lib/config";
import {
  hasBuyIntent,
  hasResumableSession,
  redirectReturningOwner,
} from "@/lib/session";
import SignupSection from "@/components/SignupSection";
import { Navbar, Footer, Glyph } from "@/components/landing";

// Effects never run during server prerender, so `useLayoutEffect` there only
// logs a warning. Fall back to `useEffect` on the server; on the client use
// the layout variant so we can swap in the "checking…" screen *before paint*
// — no flash of the signup hero for an owner we're about to redirect.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/* ------------------------------------------------------------------ */
/* One screen — headline, honest subline, signup, three true facts     */
/* ------------------------------------------------------------------ */

const facts: readonly { icon: typeof Lock; text: string }[] = [
  { icon: Lock, text: "Stored encrypted to your key" },
  { icon: Radio, text: "On relays you choose" },
  { icon: KeyRound, text: "Sign in with your own key" },
];

function Hero() {
  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-grid px-5 py-10 sm:px-6">
      <div className="absolute inset-0 bg-grid-lg pointer-events-none" />
      <div className="relative w-full max-w-2xl text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-widest text-primary xs:text-xs">
          <AtSign size={13} /> you@{config.mailDomain}
        </div>

        <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight text-ink xs:text-5xl sm:text-6xl">
          Email locked to <span className="text-emphasis">your key.</span>
        </h1>

        <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-gray-600 sm:text-lg">
          Mail to you@{config.mailDomain} is stored encrypted to your key, on
          relays you choose. You sign in with your own key.
        </p>

        <div className="mx-auto max-w-xl text-left">
          <SignupSection />
        </div>

        <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-gray-500">
          {facts.map((f) => (
            <li key={f.text} className="flex items-center gap-1.5">
              <f.icon size={15} className="text-primary" />
              {f.text}
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Checking screen — held while we decide owner-vs-visitor              */
/* ------------------------------------------------------------------ */

// Shown to a returning visitor while the silent resume runs, so an owner is
// never flashed the signup hero on the way to their inbox. Same paper canvas
// as the landing page, so if we do fall through to the hero there's no jarring
// swap of background.
function CheckingScreen() {
  return (
    <div className="safe-y flex min-h-[100svh] flex-col items-center justify-center gap-4 bg-paper text-ink">
      <Glyph className="h-12 w-12 animate-pulse" />
      <p className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={15} className="animate-spin text-primary" />
        Opening your inbox…
      </p>
    </div>
  );
}

/**
 * The landing route: a returning user who already owns a mailbox is sent
 * straight to the inbox rather than being shown the signup hero again. While
 * that silent resume runs we hold a "checking…" screen so the owner never sees
 * the landing page flash by. A brand-new visitor (no persisted account) and
 * any `?buy=1` deep link (an owner here to claim another address — see
 * session.ts) skip the check entirely and get the hero immediately.
 */
export default function Home() {
  const [checking, setChecking] = useState(false);

  useIsomorphicLayoutEffect(() => {
    if (hasBuyIntent() || !hasResumableSession()) return;
    setChecking(true);
    void redirectReturningOwner().then((redirected) => {
      // Not an owner (or the resume failed) — reveal the landing page.
      // On success the browser is already navigating away, so leave the
      // checking screen up rather than flashing the hero mid-redirect.
      if (!redirected) setChecking(false);
    });
  }, []);

  if (checking) return <CheckingScreen />;

  return (
    // min-h (not fixed h + overflow-hidden) so a short viewport — a small
    // phone in particular — scrolls the hero instead of clipping it.
    <div className="safe-y flex min-h-[100svh] flex-col bg-paper text-ink">
      <Navbar />
      <Hero />
      <Footer />
    </div>
  );
}