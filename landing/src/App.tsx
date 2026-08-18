import { useLayoutEffect, useEffect, useState } from "react";
import {
  AtSign,
  Github,
  Inbox,
  KeyRound,
  Loader2,
  Lock,
  Radio,
} from "lucide-react";
import "./index.css";
import { config } from "./lib/config";
import {
  hasBuyIntent,
  hasResumableSession,
  redirectReturningOwner,
} from "./lib/session";
import SignupSection from "./components/SignupSection";

// Effects never run during server prerender, so `useLayoutEffect` there only
// logs a warning. Fall back to `useEffect` on the server; on the client use
// the layout variant so we can swap in the "checking…" screen *before paint*
// — no flash of the signup hero for an owner we're about to redirect.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
import PrivacyPolicy from "./pages/PrivacyPolicy";

/* ------------------------------------------------------------------ */
/* Brand glyph — an envelope carrying the Formstr asterisk             */
/* ------------------------------------------------------------------ */

function Glyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="4" y="12" width="56" height="40" rx="8" fill="#0b0b0c" />
      <path
        d="M8 18 L32 38 L56 18"
        fill="none"
        stroke="#f4f4f3"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="50" cy="14" r="10" fill="#f4f4f3" />
      <path
        d="M50 8.5 L50 19.5 M45.2 11.25 L54.8 16.75 M45.2 16.75 L54.8 11.25"
        stroke="#e5484d"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Nav                                                                 */
/* ------------------------------------------------------------------ */

export function Navbar() {
  return (
    <nav className="shrink-0 border-b border-black/5">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
        <a href="/" className="flex min-w-0 items-center gap-2.5">
          <Glyph className="h-8 w-8 shrink-0" />
          <span className="flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="font-mono text-lg font-bold text-ink">mail</span>
            <span className="font-mono text-xs font-semibold uppercase tracking-wide text-gray-400">
              by formstr
            </span>
          </span>
        </a>
        <div className="flex shrink-0 items-center gap-3 sm:gap-4">
          <a
            href="https://github.com/formstr-hq"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 transition-colors hover:text-ink"
            aria-label="GitHub"
          >
            <Github size={20} />
          </a>
          <a
            href={config.mailsUrl}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-ink/85 sm:px-4"
          >
            <Inbox size={15} />
            <span className="hidden xs:inline">Open inbox</span>
            <span className="xs:hidden">Inbox</span>
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* One screen — headline, honest subline, signup, three true facts     */
/* ------------------------------------------------------------------ */

const facts = [
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
/* Footer — a thin bar, part of the single screen                      */
/* ------------------------------------------------------------------ */

export function Footer() {
  return (
    <footer className="shrink-0 border-t border-black/5">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-4 text-xs text-gray-500">
        <span>A Formstr product.</span>
        <div className="flex items-center gap-x-5">
          <a
            href="https://about.formstr.app"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-ink"
          >
            The Formstr suite
          </a>
          <a href="/privacy-policy" className="transition-colors hover:text-ink">
            Privacy
          </a>
        </div>
      </div>
    </footer>
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
    <div className="flex min-h-[100svh] flex-col items-center justify-center gap-4 bg-paper text-ink">
      <Glyph className="h-12 w-12 animate-pulse" />
      <p className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={15} className="animate-spin text-primary" />
        Opening your inbox…
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function Home() {
  // A returning user who already owns a mailbox is sent straight to the inbox
  // rather than being shown the signup hero again. While that silent resume
  // runs we hold a "checking…" screen so the owner never sees the landing page
  // flash by. A brand-new visitor (no persisted account) and any `?buy=1` deep
  // link (an owner here to claim another address — see session.ts) skip the
  // check entirely and get the hero immediately.
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
    <div className="flex min-h-[100svh] flex-col bg-paper text-ink">
      <Navbar />
      <Hero />
      <Footer />
    </div>
  );
}

function App({ url }: { url?: string }) {
  const rawPath =
    url ?? (typeof window !== "undefined" ? window.location.pathname : "/");
  // nginx serves the prerendered directory with a trailing slash, so the
  // client path can be "/privacy-policy/" while the route table below is
  // "/privacy-policy". Normalize by stripping a single trailing slash
  // (except for the root itself) so hydration matches the prerendered tree.
  const path = rawPath.length > 1 && rawPath.endsWith("/")
    ? rawPath.slice(0, -1)
    : rawPath;
  if (path === "/privacy-policy") return <PrivacyPolicy />;
  return <Home />;
}

export default App;
