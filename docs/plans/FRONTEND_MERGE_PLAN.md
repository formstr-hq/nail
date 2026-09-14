# Nail FE — Merge Client + Landing into One App (Plan)

Owner asks: combine client and landing into one SEO-friendly app where the client is the mail client. Plus AGENTS.md for the frontend. Model: Kimi K3 (for the agent implementing this — note below).

## Target architecture

```
nail/
  web/                 # merged frontend (single Vite app)
    src/
      routes/          # / (landing, prerendered) · /privacy-policy · /app/* (mail SPA)
      app/             # mail client: components/, hooks/, store/, lib/
      landing/         # hero, signup wizard, privacy policy
      lib/             # shared: nip98, platform, session, signer, api
      entry-server.tsx # existing SSG pipeline, extended to /app routes → shell only
  (client/, landing/   # deleted at phase 4; /mails is served by web/ itself)
```

- **Routing:** react-router. `/` and `/privacy-policy` render landing components; `/app/*` mounts MailApp. Prerender landing routes to static HTML (SEO preserved — landing already has prerender.js + JSON-LD; keep it). `/app/*` gets an SPA shell with `noindex`.
- **Sign-in gating:** `/app` redirects to `/` (hero+signup) when no account — same `hasResumableSession()`/`redirectReturningOwner()` flow already in landing.
- **React: unify on 19.** Client is on 18.3 — upgrade (no concurrent features in use that block it; verify Capacitor plugin + `@formstr/signer` UI on 19; landing already proves 19 works).
- **Tailwind: unify on 4** (landing has it; client's config is small — port tokens to CSS-first config).
- **Vite: unify on 7**; carry over client's critical config: es2020/safari14 build target, IIFE worker for the local relay, `@protocol` + `dedupe` aliases, `/api` proxy.
- **Docker:** one image; nginx serves prerendered landing statically and the app shell for `/app/*` (in practice `/mails/*`).

## Phases (each independently shippable)

1. **Monorepo prep (no behavior change).** Create `web/` with landing's build + client's env. Move shared duplicated modules (`nip98`, `platform`, signer-UI tuning) into `web/src/lib/`. CI: build, lint, unit tests, Playwright for both flows.
2. **React/Tailwind/Vite unification in web/.** Port client source in; get unit + e2e suites green against one dependency set.
3. **Router + route merge.** Add react-router; MailApp behind `/app`; delete hand-rolled overlay stack where the router replaces it (keep Android back handler, now fed by router state); move `selfAddresses` into a hook. **Done — with two deviations:** (a) the app path stays `config.mailsUrl` (`/mails`), not `/app` — that path is baked into nginx, the Capacitor bundle (`mobile/scripts/build-web.mjs`), the post-login redirect, and every e2e spec; the Android build also mounts the whole app under its Vite `base` (`CLIENT_BASE_PATH`), so the route prefix derives from `import.meta.env.BASE_URL` falling back to `mailsUrl`. (b) `/mails` does **not** redirect signed-out users to `/`: the client's own `LoginPage` must keep rendering there, or the Capacitor shell (which boots at `/mails`) would bounce users to the hero with no way back. Sign-in gating is only the landing→app direction (`redirectReturningOwner`).
4. **Prerender + nginx + deploy switch. — Done.** Extend prerender.js routes; nginx config: prerendered files → static, `/app` → SPA shell; delete old `client/`, `landing/`. **Deviations:** (a) the shell lives at `config.mailsUrl` (`/mails`), not `/app` — phase 3's path constraint holds; prerender.js derives the shell path from it (stripping a trailing `/index.html` for the mobile build, which sets `VITE_MAILS_URL=/mails/index.html` so Capacitor's non-directory-resolving server finds the file). (b) `client/` and `landing/` are deleted in the same phase — nothing referenced them for a cutover window; per-route nginx redirects are unnecessary since the merged app serves the same paths on the same origin. (c) The mobile bundle can't share assets between `/` and `/mails/` (Capacitor's server has no rewrites), so `build-web.mjs` copies the shared `assets/` into `www/mails/assets/` after the single build.
5. **Refactor pass (post-merge, separate PRs). — Done.** Split god components (ComposeModal → hooks + 4 subcomponents; SettingsModal/PgpSettings → per-section files); extract inbox decode queue from `useInbox` into a testable service; introduce `zustand/persist` middleware replacing 4 hand-rolled localStorage idioms; add component tests for EmailList/ComposeModal happy paths. **Deviations:** (a) landed as five commits on `app_restructure` rather than separate PRs; (b) the mail store's persist uses a splitting `PersistStorage` over the same three legacy keys (bare shapes) with the `mailstr.read` fold in `merge` (runs every hydration) — legacy keys are never deleted, per AGENTS rule 8; (c) `freshSignup` stays hand-rolled deliberately — it is a cross-app contract with the landing signup wizard, not a store; (d) component tests add `@testing-library/react` + `happy-dom`, opted into per-file via the `@vitest-environment happy-dom` docblock so the rest of the suite stays in plain node.

## Risks

- Capacitor/webview behavior differences after React 19 bump → run Android e2e (`client/e2e` + `installAndroidBackHandler` tests).
- Prerender must not ship the mail shell to crawlers → verify `noindex` + no mail markup in `/app` HTML.
- Auth/session storage keys change nothing (same origins, same localStorage) — but the merged origin means client and landing now share localStorage namespace: audit key collisions (`mailstr.*` vs landing keys) before cutover.
