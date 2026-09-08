# mailstr.app — merged web frontend

One app for [mailstr.app](https://mailstr.app): the SEO-ready landing
(prerendered at build time, Vite SSG, styled after `about-formstr`) plus the
mail client mounted at `/mails`. Signup is driven by the formstr-backend APIs.

## Routes

- `/` — landing page with the signup flow (prerendered)
- `/privacy-policy` — rendered from `src/pages/privacy-policy.md` (prerendered)
- `/mails` — the mail client (SPA shell; `noindex`, empty HTML — the client
  renders entirely after hydration)

## Signup flow

1. The hero input accepts an `npub`, hex pubkey, bare name, or
   `name@mailstr.app`.
2. `GET /api/mails/mailbox/:pubkey` — if a mailbox exists, the user is
   redirected to the mail UI at `/mails`.
3. Otherwise the wizard opens: sign in with `@formstr/signer` (NIP-07 /
   NIP-46 / NIP-49 / NIP-55), pick a name (availability via
   `GET /api/nip-05/get-pubkey/:name`), then
   `POST /api/generate-invoice/mail` (NIP-98 auth) returns a Lightning
   invoice. A WebSocket on `?hash=<paymentHash>` reports `paid`, the backend
   provisions the mailbox + NIP-05, and the user is redirected to `/mails`.

## Development

```bash
pnpm install
pnpm dev           # expects formstr-backend on http://localhost:5000
pnpm build         # tsc + client build + SSR build + prerender (+ SPA shell)
pnpm test          # vitest unit tests (lib/ modules)
pnpm e2e           # Playwright: landing + mail app specs against a mock relay
pnpm preview
```

Configuration is env-driven (see `.env.example`): `VITE_API_BASE_URL`,
`VITE_WS_BASE_URL`, `VITE_API_CANONICAL_BASE_URL`, `VITE_MAIL_DOMAIN`,
`VITE_MAILS_URL`. Dev defaults point at `http://localhost:5000`; production
defaults at `https://api.formstr.app`.

## Deployment

One Docker service builds the whole site and copies the dist to a host
directory that the external nginx serves:

```bash
cp .env.example .env   # set WEB_DIST_PATH (and API URLs if different)
docker compose up --build
```

The container exits after copying — re-run it to redeploy.

### External nginx

The dist is fully static: prerendered landing pages at the root, the noindex
SPA shell at `/mails/index.html`. `/mails` needs no proxy any more — every
`/mails/*` URL serves the shell and the app hydrates on top:

```nginx
server {
    server_name mailstr.app;

    root /var/www/mailstr;   # = WEB_DIST_PATH
    index index.html;

    # mail UI: SPA shell + its assets (history navigations need the fallback)
    location /mails {
        try_files $uri $uri/ /mails/index.html;
    }

    # prerendered routes resolve to their own index.html; anything else
    # falls back to the landing SPA shell
    location / {
        try_files $uri $uri/index.html /index.html;
    }
}
```

If a path other than `/mails` is ever needed, set `VITE_MAILS_URL` at build
time — the router prefix, the prerendered shell location, and the signup
redirects all derive from it.

### Backend prerequisites

- `mailstr.app` must be in formstr-backend's CORS allowlist
  (`src/config/corsConfig.ts`).
- The backend deployment must run with `MAIL_DOMAIN=mailstr.app` (NIP-05
  records and mailcow local parts derive from it) and a configured `LUD16`
  for invoice generation.

## Assets

`public/og-image.png` is referenced by the OG/Twitter meta tags but not
checked in — drop a 1200×630 image there before launch. `public/favicon.svg`
is a placeholder glyph; replace at will.