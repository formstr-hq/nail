import { useEffect } from "react";
import type { CSSProperties } from "react";
import {
  ArrowRight,
  AtSign,
  BadgeCheck,
  Check,
  Github,
  Inbox,
  KeyRound,
  Lock,
  Mail,
  Send,
  ShieldCheck,
  Zap,
} from "lucide-react";
import "./index.css";
import { config } from "./lib/config";
import SignupSection from "./components/SignupSection";
import PrivacyPolicy from "./pages/PrivacyPolicy";

/* Stagger helper: delays a `.reveal` element's transition so grid siblings
   cascade in one after another instead of all at once. */
const rv = (step: number): CSSProperties =>
  ({ "--rd": `${step * 90}ms` }) as CSSProperties;

/* Scroll effects, JS-driven so they work on every browser (incl. iOS Safari,
   which doesn't support CSS scroll-timelines):
   - IntersectionObserver reveals `.reveal` elements as they enter the viewport
   - a passive scroll listener feeds the top progress bar
   Both honor prefers-reduced-motion and degrade gracefully without JS. */
function useScrollFx() {
  useEffect(() => {
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));

    let io: IntersectionObserver | undefined;
    if (reduce || typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("is-visible"));
    } else {
      io = new IntersectionObserver(
        (entries, obs) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add("is-visible");
              obs.unobserve(e.target);
            }
          }
        },
        { threshold: 0.15, rootMargin: "0px 0px -10% 0px" },
      );
      els.forEach((el) => io!.observe(el));
    }

    const bar = document.querySelector<HTMLElement>(".scroll-progress");
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const doc = document.documentElement;
        const max = doc.scrollHeight - doc.clientHeight;
        const p = max > 0 ? Math.min(doc.scrollTop / max, 1) : 0;
        bar?.style.setProperty("--scroll", String(p));
      });
    };
    if (!reduce && bar) {
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
    }

    return () => {
      io?.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}

/* ------------------------------------------------------------------ */
/* Brand glyph — an envelope carrying the Formstr asterisk             */
/* ------------------------------------------------------------------ */

function Glyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="mailg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff5c00" />
          <stop offset="1" stopColor="#ffb020" />
        </linearGradient>
      </defs>
      <rect x="4" y="12" width="56" height="40" rx="8" fill="url(#mailg)" />
      <path
        d="M8 18 L32 38 L56 18"
        fill="none"
        stroke="#f7f5ef"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="50" cy="14" r="10" fill="#0b0b0c" />
      <path
        d="M50 8.5 L50 19.5 M45.2 11.25 L54.8 16.75 M45.2 16.75 L54.8 11.25"
        stroke="#ffb020"
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
    <nav className="sticky top-0 z-50 border-b border-black/5 bg-paper/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <a href="/" className="flex items-center gap-2.5">
          <Glyph className="h-8 w-8" />
          <span className="font-mono text-lg font-bold italic text-ink">
            mailstr
          </span>
        </a>
        <div className="flex items-center gap-3 sm:gap-4">
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-ink/85"
          >
            <Inbox size={15} /> Open inbox
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function BridgeVisual() {
  return (
    <div className="space-y-3">
      {/* incoming email */}
      <div className="reveal reveal-right rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
        <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-gray-400">
          <Mail size={14} /> What they send
        </p>
        <div className="rounded-lg border border-black/5 bg-paper p-4">
          <p className="font-mono text-xs text-gray-400">
            To: <span className="text-ink">you@{config.mailDomain}</span>
          </p>
          <p className="mt-1 text-sm font-bold text-ink">Invoice for June</p>
          <p className="mt-1 text-xs text-gray-500">
            Hi — attached is the invoice we discussed…
          </p>
        </div>
      </div>

      <div
        className="reveal flex items-center justify-center gap-2 text-xs font-semibold text-primary"
        style={rv(1)}
      >
        <Lock size={14} /> encrypted to your key, handed to your relays ↓
      </div>

      {/* what the relay stores */}
      <div
        className="reveal reveal-right rounded-2xl border border-ink/90 bg-ink p-5 text-white"
        style={rv(2)}
      >
        <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-white/40">
          <ShieldCheck size={14} /> What the relay stores
        </p>
        <pre className="overflow-hidden whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-white/35">
          {`kind: 1059
content: "AqT8x2Vd9Kf3mPz7rR4v
N6wYbH1eL5cJs0Uo2aZ...==" 🔒
sig: 7c2f...a04`}
        </pre>
      </div>

      <div
        className="reveal flex items-center justify-center gap-2 text-xs font-semibold text-primary"
        style={rv(3)}
      >
        <KeyRound size={14} /> only your key opens it ↓
      </div>

      {/* your inbox */}
      <div
        className="reveal reveal-right rounded-2xl border border-primary/30 bg-primary/[0.06] p-5"
        style={rv(4)}
      >
        <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
          <Inbox size={14} /> What you read
        </p>
        <div className="rounded-lg bg-white p-4">
          <p className="text-sm font-bold text-ink">Invoice for June</p>
          <p className="mt-1 text-xs text-gray-500">
            Hi — attached is the invoice we discussed…
          </p>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-grid">
      <div className="absolute inset-0 bg-grid-lg pointer-events-none" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-16 lg:grid-cols-2 lg:pb-28 lg:pt-24">
        <div>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3.5 py-1.5 text-xs font-bold uppercase tracking-widest text-primary">
            <AtSign size={13} /> you@{config.mailDomain}
          </div>
          <h1 className="text-5xl font-extrabold leading-[1.04] tracking-tight text-ink sm:text-6xl">
            An email address
            <br />
            no one can
            <br />
            take <span className="text-primary">from you.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-gray-600">
            Mailstr bridges email to Nostr. Mail sent to you@
            {config.mailDomain} arrives as an encrypted message to your Nostr
            key —{" "}
            <span className="font-semibold text-ink">
              no password to phish, no account to ban, no inbox mining your
              life.
            </span>
          </p>

          <SignupSection />

          <p className="mt-4 flex items-center gap-2 text-sm text-gray-500">
            <KeyRound size={15} className="text-primary" />
            Bring your own Nostr key, or create one during signup.
          </p>
        </div>

        <div className="lg:pl-6">
          <BridgeVisual />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* How it works                                                        */
/* ------------------------------------------------------------------ */

function HowItWorks() {
  const steps = [
    {
      icon: AtSign,
      title: "Claim your address",
      text: `Pick a name, pay once over Lightning, and ${"you"}@${config.mailDomain} is bound to your Nostr key. It doubles as your NIP-05 handle — a verified name in every Nostr client.`,
    },
    {
      icon: Mail,
      title: "Mail arrives as Nostr",
      text: "Anyone can email you from a normal inbox. The bridge encrypts each message to your key and hands it to relays — from that moment, only you can read it.",
    },
    {
      icon: Send,
      title: "Read & reply anywhere",
      text: `Open your inbox at ${config.mailDomain}/mails, signed in by your key. Reply and the bridge sends a normal email back — the sender never has to know Nostr exists.`,
    },
  ];
  return (
    <section id="how" className="border-t border-black/5">
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
        <div className="reveal mb-12 max-w-2xl">
          <p className="mb-3 text-sm font-bold uppercase tracking-widest text-primary">
            How it works
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Email on their side. Nostr on yours.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-gray-600">
            The rest of the world keeps sending email the way it always has. You
            receive it on infrastructure that answers to your key instead of an
            account someone else controls.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <div
              key={s.title}
              style={rv(i)}
              className="reveal reveal-scale rounded-2xl border border-black/10 bg-white p-7 transition-all hover:-translate-y-1 hover:shadow-xl"
            >
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
                <s.icon size={20} className="text-primary" />
              </div>
              <p className="mb-1 font-mono text-xs font-semibold text-gray-400">
                step {i + 1}
              </p>
              <h3 className="mb-2 text-lg font-bold text-ink">{s.title}</h3>
              <p className="text-sm leading-relaxed text-gray-600">{s.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Thesis — renting vs owning your inbox                               */
/* ------------------------------------------------------------------ */

function Thesis() {
  const rented = [
    "Your address is a hostage — lose the account, lose everything tied to it",
    "Every message scanned for ads, profiles, and AI training",
    "Recovery phones, password resets, lockouts at the worst moment",
    "Free, because you're the product",
  ];
  const owned = [
    "Your address answers to a key only you hold — nothing to ban",
    "Messages encrypted to your key before they reach any relay",
    "Sign in by signing — no password to phish or reset",
    "One Lightning payment. You're the customer, not the product",
  ];
  return (
    <section id="thesis" className="border-t border-black/5 bg-ink text-white">
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
        <div className="reveal max-w-2xl">
          <p className="mb-3 text-sm font-bold uppercase tracking-widest text-primary-light">
            The thesis
          </p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Your inbox is the master key to your life. You're renting it.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-white/60">
            Bank logins, contracts, password resets — everything routes through
            an email account a company can read, mine, or close. Mailstr moves
            the address onto your Nostr key: your mail, your key, yours to keep.
          </p>
        </div>

        <div className="mt-12 grid gap-5 md:grid-cols-2">
          <div className="reveal reveal-left rounded-2xl border border-white/10 bg-white/[0.03] p-7">
            <p className="mb-5 inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-white/40">
              <Lock size={16} /> Renting
            </p>
            <ul className="space-y-3.5">
              {rented.map((r) => (
                <li key={r} className="flex gap-3 text-white/55">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-white/30" />
                  <span className="leading-relaxed line-through decoration-white/20">
                    {r}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="reveal reveal-right rounded-2xl border border-primary/30 bg-primary/[0.07] p-7">
            <p className="mb-5 inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-primary-light">
              <KeyRound size={16} /> Owning
            </p>
            <ul className="space-y-3.5">
              {owned.map((o) => (
                <li key={o} className="flex gap-3 text-white/90">
                  <Check
                    size={18}
                    className="mt-0.5 shrink-0 text-primary-light"
                  />
                  <span className="leading-relaxed">{o}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Privacy — honest about what a bridge can and cannot promise         */
/* ------------------------------------------------------------------ */

function Privacy() {
  return (
    <section id="privacy" className="border-t border-black/5 bg-grid">
      <div className="absolute inset-0 bg-grid-lg pointer-events-none" />
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
        <div className="reveal max-w-2xl">
          <p className="mb-3 inline-flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-primary">
            <ShieldCheck size={16} /> Straight answers
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            What the bridge sees — and what it doesn't keep.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-gray-600">
            Email arrives at the bridge the way email always arrives: readable
            in transit. That's how SMTP works, and anyone who tells you
            otherwise is selling something. What matters is what happens next.
          </p>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {[
            {
              title: "Encrypted on arrival",
              text: "The moment a message reaches the bridge, it's encrypted to your public key and handed to relays. What's stored is ciphertext only your key opens.",
            },
            {
              title: "Nothing retained, nothing mined",
              text: "The bridge doesn't keep a plaintext archive, doesn't scan for ads, and has no analytics on your mail. Its job is to translate and forget.",
            },
            {
              title: "Open source, checkable",
              text: "The bridge code is open. You don't have to take our word for what it does with your mail — read it, or run your own.",
            },
          ].map((c, i) => (
            <div
              key={c.title}
              style={rv(i)}
              className="reveal rounded-2xl border border-black/10 bg-white p-7"
            >
              <h3 className="mb-2 font-bold text-ink">{c.title}</h3>
              <p className="text-sm leading-relaxed text-gray-600">{c.text}</p>
            </div>
          ))}
        </div>

        <p className="reveal mt-8 hand text-2xl text-primary">
          your keys, your mail, our open source.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* NIP-05 identity                                                     */
/* ------------------------------------------------------------------ */

function Identity() {
  return (
    <section
      id="identity"
      className="border-t border-black/5 bg-ink text-white"
    >
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2 lg:py-24">
        <div className="reveal reveal-left">
          <p className="mb-3 inline-flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-primary-light">
            <BadgeCheck size={16} /> Two for one
          </p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Your address is also your Nostr name.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-white/65">
            Every Mailstr address is a NIP-05 identifier. The same you@
            {config.mailDomain} that receives your email shows up as your
            verified handle in Damus, Amethyst, Primal — any Nostr client.
          </p>
          <p className="mt-4 text-lg leading-relaxed text-white/65">
            One name, findable everywhere:{" "}
            <span className="font-semibold text-white">
              people can mail it or follow it.
            </span>
          </p>
        </div>

        <div className="reveal reveal-right rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <div className="flex items-center gap-3 border-b border-white/10 pb-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/20 font-bold text-primary-light">
              A
            </div>
            <div>
              <p className="flex items-center gap-1.5 font-bold">
                alice
                <BadgeCheck size={15} className="text-primary-light" />
              </p>
              <p className="font-mono text-xs text-white/45">
                alice@{config.mailDomain}
              </p>
            </div>
            <span className="ml-auto rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white/60">
              verified
            </span>
          </div>
          <div className="space-y-3 pt-4 text-sm">
            <p className="flex items-center gap-2 text-white/70">
              <Mail size={15} className="shrink-0 text-primary-light" />
              Reachable by email from any inbox on earth
            </p>
            <p className="flex items-center gap-2 text-white/70">
              <BadgeCheck size={15} className="shrink-0 text-primary-light" />
              Verified handle in every Nostr client
            </p>
            <p className="flex items-center gap-2 text-white/70">
              <KeyRound size={15} className="shrink-0 text-primary-light" />
              Both bound to a key only you hold
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Pricing CTA                                                         */
/* ------------------------------------------------------------------ */

function Pricing() {
  return (
    <section id="pricing" className="border-t border-black/5">
      <div className="reveal mx-auto max-w-2xl px-6 py-20 text-center lg:py-24">
        <Zap size={36} className="mx-auto mb-5 text-primary" />
        <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          One Lightning payment. That's the business model.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-gray-600">
          No free tier funded by reading your mail. No subscription that holds
          your address hostage. You pay once in sats when you claim your name —
          the current price shows up right in the signup flow.
        </p>
        <a
          href="#top"
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
        >
          Claim your address <ArrowRight size={16} />
        </a>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* FAQ — native details/summary so crawlers and no-JS users get it all */
/* ------------------------------------------------------------------ */

function Faq() {
  const faqs = [
    {
      q: "Do I need to know anything about Nostr?",
      a: "No. If you already have a Nostr key, sign in with it. If you don't, the signup flow creates one for you in a tap — protected by a passphrase, held on your device, never on our servers.",
    },
    {
      q: "Is my mail end-to-end encrypted?",
      a: "From the bridge to you, yes — messages are encrypted to your key before they touch a relay. The leg from the sender to the bridge is ordinary email, which is not end-to-end encrypted anywhere, for anyone. We're honest about that line; most providers just don't mention it.",
    },
    {
      q: "What happens if I lose my key?",
      a: "The same thing that makes your address impossible to confiscate makes it impossible for us to recover: we never have your key. Back it up. That trade — self-custody for recoverability — is the whole point.",
    },
    {
      q: "Can I send email too, or only receive?",
      a: `Both. Reply from your inbox at ${config.mailDomain}/mails and the bridge delivers a normal email from your address. The person on the other end just sees email.`,
    },
    {
      q: "What exactly does my payment buy?",
      a: `Your name@${config.mailDomain} mailbox and the matching NIP-05 identity, bound to your pubkey. Payment is a Lightning invoice settled as a Nostr zap — the receipt is public, pseudonymous proof of your claim.`,
    },
    {
      q: "Who runs this?",
      a: "Formstr — the team behind the open-source Formstr suite of Nostr apps (forms, docs, calendar, drive). The bridge and this page are open source like everything else we ship.",
    },
  ];
  return (
    <section id="faq" className="border-t border-black/5 bg-paper">
      <div className="mx-auto max-w-3xl px-6 py-20 lg:py-24">
        <div className="reveal mb-10">
          <p className="mb-3 text-sm font-bold uppercase tracking-widest text-primary">
            FAQ
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Fair questions.
          </h2>
        </div>
        <div className="reveal space-y-3">
          {faqs.map((f) => (
            <details
              key={f.q}
              className="group rounded-2xl border border-black/10 bg-white px-6 py-4 open:shadow-sm"
            >
              <summary className="cursor-pointer list-none text-[15px] font-bold text-ink marker:hidden">
                {f.q}
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-gray-600">
                {f.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Footer                                                              */
/* ------------------------------------------------------------------ */

export function Footer() {
  return (
    <footer className="border-t border-black/10 bg-ink text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <Glyph className="h-9 w-9" />
            <div>
              <p className="font-mono text-lg font-bold italic">mailstr</p>
              <p className="text-sm text-white/50">Email for your Nostr key.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/60">
            <a
              href={config.mailsUrl}
              className="transition-colors hover:text-white"
            >
              Open inbox
            </a>
            <a
              href="https://about.formstr.app"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-white"
            >
              The Formstr suite
            </a>
            <a
              href="https://github.com/formstr-hq"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-white"
            >
              GitHub
            </a>
            <a
              href="https://nostr.org"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-white"
            >
              Nostr
            </a>
            <a
              href="/privacy-policy"
              className="transition-colors hover:text-white"
            >
              Privacy Policy
            </a>
          </div>
        </div>
        <p className="mt-8 border-t border-white/10 pt-6 text-xs text-white/40">
          A Formstr product. Your keys, your mail, your name.
        </p>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function Home() {
  useScrollFx();
  return (
    <div id="top" className="min-h-screen bg-paper text-ink">
      <div className="scroll-progress" aria-hidden="true" />
      <Navbar />
      <Hero />
      <HowItWorks />
      <Thesis />
      <Privacy />
      <Identity />
      <Pricing />
      <Faq />
      <Footer />
    </div>
  );
}

function App({ url }: { url?: string }) {
  const path =
    url ?? (typeof window !== "undefined" ? window.location.pathname : "/");
  if (path === "/privacy-policy") return <PrivacyPolicy />;
  return <Home />;
}

export default App;
