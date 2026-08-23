# Mailstr — Android (Capacitor)

Wraps the existing web apps in a native Android shell. Nothing is rewritten:
the landing site and the mail client are built as-is and bundled together.

## Layout inside the APK

The deployed site is two same-origin apps — `landing` at `/` and `client` at
`/mails/`. The app reproduces that exactly in one `webDir`:

```
www/
├── index.html          landing (marketing + buy/signup)  → '/'
├── mails/index.html    the mail client                   → '/mails/'
└── assets/…            landing assets;  mails/assets/… client assets
```

A signed-out user opens on the landing page. Buying an address and the
"Open inbox" handoff navigate to the client, same as on the web.

## Build

```bash
npm install              # once
npm run build            # build both web apps, assemble www/, cap sync
npm run apk:debug        # -> android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run build:web` (invoked by `build`) runs each app's own build via pnpm, so
`landing/` and `client/` must have their deps installed (`pnpm install` in each).

## Status bar / safe areas

`targetSdk 35` (Android 15) forces edge-to-edge, and the StatusBar plugin's
non-overlay path is a no-op there, so the app draws behind a transparent status
bar (`overlaysWebView: true`) and the web apps pad their chrome with CSS
`env(safe-area-inset-*)` (the `.safe-y` / `.safe-bottom` / `.safe-modal`
classes). Those env values are `0` on the web, so the same source serves both.

## Gotcha: the landing → client handoff must name the file

Capacitor's local server does **not** resolve a bare directory (`/mails/`) to
its `index.html` — it falls back to the root `index.html` (the landing SPA),
which silently bounces you back to landing. So `scripts/build-web.mjs` builds
landing with `VITE_MAILS_URL=/mails/index.html` (mobile-only; the web deploy
keeps its default `/mails`).

## CI

`.github/workflows/android-apk.yml` builds the APK on manual dispatch
(`workflow_dispatch`, pick any branch incl. a PR head) and uploads it as an
artifact. Distribution target is Zapstore for now; Play Store (with release
signing) comes later.
