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

`client/` is part of the root pnpm workspace (`pnpm-workspace.yaml`), so all
dependencies install in one place — from the repo root:

```bash
pnpm install             # once, installs client/web/ + the native shell
pnpm --filter mailstr-client run build       # build the web app, assemble www/, cap sync
pnpm --filter mailstr-client run apk:debug   # -> android/app/build/outputs/apk/debug/app-debug.apk
```

Or from `client/`: `pnpm run build`, `pnpm run apk:debug`. `build:web`
(invoked by `build`) runs `client/web/`'s own build, whose deps the workspace
install already provided.

`cap sync` regenerates `android/capacitor.settings.gradle` with pnpm's
`.pnpm`-store paths; that file is generated, not hand-edited.

## Two distributions: direct APK and store builds

The same app ships in two payment shapes, as two Gradle flavors and two kinds
of web bundle. They are never interchangeable:

| | direct APK (Zapstore / sideload) | store build (Play, App Store) |
|---|---|---|
| Pays with | Lightning, card (hosted Stripe Checkout in a browser tab) | the store's in-app purchase only |
| Gradle | `assembleDirect{Debug,Release}` | `bundlePlayRelease` |
| Web bundle | `pnpm run build:web` (open) | `pnpm run build:web:store` (`VITE_STORE_BUILD=1`) |
| Native plugins | no purchase plugin: no Play Billing, no Google services | `cordova-plugin-purchase` (Play Billing / StoreKit) |
| Deep link | `com.formstr.mail://pay-return` (card checkout return) | none |

```bash
# direct APK
pnpm --filter mailstr-client run build           # open web bundle + cap sync
pnpm --filter mailstr-client run apk:direct:release

# Play bundle
pnpm --filter mailstr-client run build:store     # store web bundle + STORE_BUILD=1 cap sync
pnpm --filter mailstr-client run aab:play        # runs the bundle guard, then bundlePlayRelease
```

Store platforms forbid offering other ways to pay for digital goods, so a store
bundle must contain **no Lightning and no card code at all**. That is enforced
in layers: the payment methods are chosen on the build-time constant
`VITE_STORE_BUILD` and loaded with dynamic imports (`web/src/lib/payments/methods.ts`),
ESLint bans static imports of a rail, and `scripts/check-store-bundle.mjs`
scans every file of the finished bundle and the native project for a denylist
(Lightning, bolt11, zap, sats, stripe, the payment endpoints...). The Gradle
`pre{Direct,Play}*Build` tasks run it, so a bundle of the wrong kind cannot be
packaged; `web-ci.yml` runs it on both kinds. A genuine false positive from a
vendored library goes in the script's `ALLOWLIST` with a written reason.

`cap sync` decides which plugins reach the native project (`includePlugins` in
`capacitor.config.ts`, switched by `STORE_BUILD=1`). Always rebuild the web
bundle **and** re-sync for the flavor you are about to package; the guard fails
if either is stale. The checked-in generated Gradle files are the direct
(open) state.

### iOS (App Store build)

Not generated here: `npx cap add ios` needs macOS, Xcode and CocoaPods. When
adding it: `pnpm add @capacitor/ios`, `STORE_BUILD=1 npx cap add ios`, bundle id
`com.formstr.mail`, always built with `build:web:store`. `storekit/Mailstr.storekit`
is a StoreKit configuration with the mailbox and the three seat packs for local
Xcode testing; sandbox devices and TestFlight come after. Submission needs the
privacy-policy URL, support URL, screenshots and privacy labels (public key +
purchase record). The purchase plugin is the same; `Info.plist` is covered by
the bundle guard.

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
`client/web/` with `VITE_MAILS_URL=/mails/index.html` (native-only; the web
deploy keeps its default `/mails`).

## CI

`.github/workflows/android-apk.yml` builds the APK on manual dispatch
(`workflow_dispatch`, pick any branch incl. a PR head) and uploads it as an
artifact. Distribution target is Zapstore for now; Play Store (with release
signing) comes later.
