import { ArrowRight, AtSign, Building2, Check, Github, Inbox } from "lucide-react";
import { Link } from "react-router";
import { config } from "@/lib/config";
import SignupSection from "./SignupSection";

/** The mail app's base, tolerating the Capacitor build's explicit index file. */
const MAILS_BASE =
  config.mailsUrl.replace(/\/index\.html$/, "").replace(/\/+$/, "") || "/mails";

/* ------------------------------------------------------------------ */
/* Brand glyph — an envelope carrying the Formstr asterisk             */
/* ------------------------------------------------------------------ */

/** The Mail by Form* mark for inline use: same red envelope + white flap as
 * the Android launcher icon, but TILE-LESS — the launcher's ink tile reads as a
 * heavy black badge on the landing's light chrome. The asterisk uses
 * currentColor so it adapts to whatever it sits on. The tile version lives in
 * the favicon / native icon (scripts/render-app-icon.py); geometry is shared. */
export function Glyph({ className = "" }: { className?: string }) {
  const AST = { cx: 70, cy: 38, arm: 22, w: 5, angles: [90, 30, 150] };
  const half = AST.arm / 2;
  const astLines = AST.angles.map((a) => {
    const r = (a * Math.PI) / 180;
    const dx = half * Math.cos(r);
    const dy = half * Math.sin(r);
    return { x1: AST.cx - dx, y1: AST.cy - dy, x2: AST.cx + dx, y2: AST.cy + dy };
  });
  return (
    <svg viewBox="23 15.25 68 68" className={className} aria-hidden="true">
      <rect x="32" y="40" width="44" height="34" rx="6" fill="#E5484D" />
      <path
        d="M38.5,44 L54,59 L69.5,44"
        fill="none"
        stroke="#F4F4F3"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {astLines.map((l, i) => (
        <line key={i} {...l} stroke="currentColor" strokeWidth={AST.w} strokeLinecap="round" />
      ))}
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
        <div className="flex shrink-0 items-center gap-2.5 sm:gap-4">
          <a
            href="https://github.com/formstr-hq"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden text-gray-500 transition-colors hover:text-ink xs:block"
            aria-label="GitHub"
          >
            <Github size={20} />
          </a>
          <Link
            to={`${MAILS_BASE}/workspace`}
            aria-label="Workspace"
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink/15 bg-white px-2.5 py-2 text-sm font-semibold text-ink transition-colors hover:border-ink/30 hover:bg-paper xs:px-3.5"
          >
            <Building2 size={15} />
            <span className="xs:hidden">Teams</span>
            <span className="hidden xs:inline">Workspace</span>
          </Link>
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
/* The two paths — personal and workspace, side by side                */
/* ------------------------------------------------------------------ */

/**
 * The personal path. This is where the signup form lives, so the card has to
 * be a real working surface, not a marketing tile: it owns the name/identity
 * input and hands off to the wizard exactly as the old hero did.
 */
export function PersonalCard() {
  return (
    <section
      id="personal"
      aria-labelledby="personal-heading"
      className="flex h-full min-w-0 flex-col rounded-2xl border border-ink/10 bg-surface p-5 shadow-sm sm:p-6"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">
          <AtSign size={13} />
          Personal
        </p>
        <span className="min-w-0 truncate rounded-full bg-paper px-2.5 py-1 font-mono text-[10px] font-medium text-gray-500">
          you@{config.mailDomain}
        </span>
      </div>

      <h2
        id="personal-heading"
        className="mt-4 text-xl font-extrabold tracking-tight text-ink sm:text-2xl"
      >
        An address of your own.
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">
        Encrypted to your key, stored on relays you choose.
      </p>

      <SignupSection className="mt-5" />

      <p className="mt-auto pt-5 text-xs text-gray-500">
        Already have an address?{" "}
        <a
          href={config.mailsUrl}
          className="font-semibold text-ink underline decoration-ink/20 underline-offset-2 transition-colors hover:decoration-ink"
        >
          Open your inbox →
        </a>
      </p>
    </section>
  );
}

/**
 * The team path. Deliberately the ink card beside the paper one: neither
 * product is buried beneath the other, and the copy names the shared
 * encryption/relay model before it asks for the domain.
 */
export function WorkspaceCard() {
  return (
    <section
      id="workspace"
      aria-labelledby="workspace-heading"
      className="flex h-full min-w-0 flex-col rounded-2xl border border-white/10 bg-ink p-5 text-white shadow-sm sm:p-6"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">
          <Building2 size={13} />
          Workspace
        </p>
        <span className="min-w-0 truncate rounded-full border border-white/15 px-2.5 py-1 font-mono text-[10px] font-medium text-white/60">
          you@yourdomain.com
        </span>
      </div>

      <h2
        id="workspace-heading"
        className="mt-4 text-xl font-extrabold tracking-tight sm:text-2xl"
      >
        A domain for your team.
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-white/65">
        Bring a domain you own and give everyone on your team an address there.
        Same encryption, same relays.
      </p>

      <ul className="mt-5 space-y-2.5 border-t border-white/10 pt-4 text-sm text-white/70">
        {[
          "Custom domain, verified by DNS",
          "One private inbox per teammate",
          "Seats billed per address",
        ].map((item) => (
          <li key={item} className="flex items-start gap-2">
            <Check size={14} className="mt-0.5 flex-none text-white/40" />
            {item}
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-5">
        <Link
          to={`${MAILS_BASE}/workspace`}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-paper"
        >
          Set up a workspace
          <ArrowRight size={16} />
        </Link>
      </div>
    </section>
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