import { Github, Inbox } from "lucide-react";
import { config } from "@/lib/config";

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