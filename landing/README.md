# mailstr.app landing page

SEO-ready static landing page for [mailstr.app](https://mailstr.app) — the Nostr
mail bridge. Prerendered at build time (Vite SSG), styled after
`about-formstr`, with a paid signup flow driven by the formstr-backend APIs.

## Pages

- `/` — landing page with the signup flow
- `/privacy-policy` — rendered from `src/pages/privacy-policy.md`

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
pnpm build         # tsc + client build + SSR build + prerender
pnpm preview
```

Configuration is env-driven (see `.env.example`): `VITE_API_BASE_URL`,
`VITE_WS_BASE_URL`, `VITE_MAIL_DOMAIN`, `VITE_MAILS_URL`. Dev defaults point
at `http://localhost:5000`; production defaults at `https://api.formstr.app`.

## Deployment

The Docker service builds the site and copies the dist to a host directory
that the external nginx serves:

```bash
cp .env.example .env   # set LANDING_DIST_PATH (and API URLs if different)
docker compose up --build
```

The container exits after copying — re-run it to redeploy.

### External nginx

```nginx
server {
    server_name mailstr.app;

    root /var/www/mailstr;   # = LANDING_DIST_PATH
    index index.html;

    # mail UI (separate repo), proxy-passed
    location /mails {
        proxy_pass http://<mail-ui-upstream>;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # prerendered routes resolve to their own index.html; anything else
    # falls back to the SPA shell
    location / {
        try_files $uri $uri/index.html /index.html;
    }
}
```

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
