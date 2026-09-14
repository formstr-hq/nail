# Mailstr — Android (Capacitor)

Wraps the merged web app in a native Android shell. Nothing is rewritten: the
prerendered landing and the mail client are built as-is and bundled together.

## Layout inside the APK

The deployed site is one app — the landing (prerendered) at `/` and the mail
client at `/mails/`. The app reproduces that exactly in one `webDir`:

```
www/
├── index.html          landing (marketing + buy/signup)  → '/'
├── mails/index.html    the mail client                   → '/mails/'
└── assets/…            shared build assets (one Vite build)
```

A signed-out user opens on the landing page. Buying an address and the
"Open inbox" handoff navigate to the client, same as on the web.

## Build

`mobile/` is part of the root pnpm workspace (`pnpm-workspace.yaml`), so all
dependencies install in one place — from the repo root:

```bash
pnpm install             # once, installs web/ + mobile/
pnpm --filter mailstr-mobile run build       # build the web app, assemble www/, cap sync
pnpm --filter mailstr-mobile run apk:debug   # -> android/app/build/outputs/apk/debug/app-debug.apk
```

Or from `mobile/`: `pnpm run build`, `pnpm run apk:debug`. `build:web`
(invoked by `build`) runs web/'s own build, whose deps the workspace install
already provided.

`cap sync` regenerates `android/capacitor.settings.gradle` with pnpm's
`.pnpm`-store paths; that file is generated, not hand-edited.

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
web/ with `VITE_MAILS_URL=/mails/index.html` (mobile-only; the web deploy
keeps its default `/mails`).

## CI

`.github/workflows/android-apk.yml` builds the APK on manual dispatch
(`workflow_dispatch`, pick any branch incl. a PR head) and uploads it as an
artifact. Distribution target is Zapstore for now; Play Store (with release
signing) comes later.
