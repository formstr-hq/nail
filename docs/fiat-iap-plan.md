# Implementation Plan: Fiat In-App Purchases (App Store + Play) for Mailstr, with Permanent Mailboxes

> Status: **Approved plan, awaiting implementation.** Everything below was verified against the
> codebase at planning time (Sep 2026); paths updated after the `client/` restructure. Repo layout:
> `formstr-backend` (payment backend, sibling repo at `../formstr-backend`), `client/web/` (merged
> frontend), `client/` (Capacitor native shell around `client/web/`'s build).

## Goals

1. Add fiat payments via **Apple In-App Purchase** and **Google Play Billing** for mailbox purchases in the native app.
2. **Store builds exclude Lightning entirely** (required by Apple 3.1.1 / Google Play billing policy anyway): the Play Store build and the iOS App Store build get IAP only — no Lightning UI, copy, or sats. **Web and the direct Android APK keep Lightning unchanged** (the APK ships outside Play — e.g. Zapstore/sideload — so store billing policy doesn't apply there). The direct APK must contain **no Google services at all**.
3. Make mailboxes **permanent** — for store payments *and* the existing Lightning flow (currently every purchase sets a 3-month `expirationDate`).
4. Scope: **mail product only**. Forms stays Lightning-only on web (backend is built so forms can adopt store payments later).
5. Integration approach: **direct store APIs** — a Capacitor IAP plugin on the client, receipt/transaction verification on formstr-backend via Google Play Developer API + Apple App Store Server API. No RevenueCat.

## Current state (verified)

```
Web (lightning):
  landing SignupWizard ──POST /api/generate-invoice/mail (NIP-98)──▶ paymentController
      │                                                                │
      │                                     resolves LUD16 zap endpoint, builds NIP-57
      │                                     zap request, gets BOLT11 invoice,
      │                                     stores pendingMails row (paymentHash,
      │                                     lnInvoice, expirationDate = +3 months)
      ▼                                                                │
  InvoiceQR (QR + lightning: URI)                                      ▼
      │                                          paymentManager.listenForPayment(hash)
      │ WS /ws?hash=…                                            ws/zapListener
      │                                          (kind-9735 zap receipts on relays)
      ◀──── {status:"paid"} ────── handleZapReceipt ──▶ provisionMailPurchase ──▶ invoices ledger
                                   (+ cron reconcilePendingMails every 15 min as backstop)

Mobile (Android only today):
  client/ = Capacitor native shell bundling landing at '/' + client at '/mails/'
  (scripts/build-web.mjs assembles www/), CapacitorHttp enabled, no iOS project yet.
  Purchases deep-link from client SettingsModal → landing ?buy=1 → same Lightning wizard.
```

Key files:
- Backend: `src/controllers/paymentController.ts`, `src/handlers/zapReceiptHandler.ts`, `src/services/mailProvisioning.ts`, `src/ws/webSocketManager.ts`, `src/models/{pendingMail,mails,nip05,invoices}.ts`, `src/controllers/utils.ts` (`getExpirationFromNow`), `migrations/`
- Landing: `client/web/src/components/SignupWizard.tsx`, `client/web/src/components/InvoiceQR.tsx`, `client/web/src/lib/{api,platform,config}.ts`
- Client: `client/web/src/app/components/SettingsModal.tsx` (buy deep-link + Lightning hint copy)
- Native shell: `client/{package.json,capacitor.config.ts,scripts/build-web.mjs,android/}`

Note: mail `expirationDate` is stored but **never enforced** (no cron deletes expired mails; `getMailboxHandler` ignores it). `cleanupCrons.ts` only expires *forms*. So going permanent is mostly "stop setting it" + a data migration.

---

## Phase 0 — Store consoles & accounts (no code)

1. **Google Play Console**
   - Confirm app `com.formstr.mail` exists (create listing if not).
   - Create one-time product (non-consumable/managed): id `mailbox_base` (naming consistent with tier ids), title "Mailbox", description, pricing (fiat price set here; store shows localized price).
   - Create a **service account**, grant it the *Financial data* role / link to Play Console (Monetization setup → API access), download JSON key.
   - Add license testers (internal testing track) for sandboxed purchases.
2. **App Store Connect**
   - App record for `com.formstr.mail` (bundle id must be registered in the developer account).
   - Sign **Paid Applications Agreement** + banking/tax — IAP products cannot be tested without it.
   - Create non-consumable IAP: product id `com.formstr.mail.mailbox.base`, pricing, localized metadata, review screenshot.
   - Create **sandbox tester** account(s).
   - Generate App Store Server API key (.p8): Key ID + Issuer ID.
3. Note pricing/parity decision: Lightning price stays in sats (backend-driven); store prices are managed in the consoles. No forced parity — the wizard shows the store's local price in IAP mode.

---

## Phase 1 — Backend (formstr-backend)

### 1a. Migrations (three new files in `migrations/`)

1. **Mail permanent** (`…_mail_permanent.ts`)
   - `mails.expirationDate` → nullable, then `UPDATE mails SET "expirationDate" = NULL` (grandfathers every existing mailbox as permanent).
   - `pendingMails.expirationDate` → nullable (column stops being written).
2. **Invoices provider + column rename** (`…_invoices_provider.ts`)
   - Rename `invoices.lnInvoice` → **`paymentInvoice`** (knex `renameColumn`; also rename `pendingMails.lnInvoice` → `paymentInvoice` for consistency) and update every code reference: `models/invoices.ts` (`InvoiceRecord`), `handlers/zapReceiptHandler.ts`, `services/mailProvisioning.ts`, `scripts/backfillInvoiceLnInvoice.ts`, `scripts/reconcileMailInvoice.ts`.
   - Add `provider` string NOT NULL default `'lightning'` (`'lightning' | 'apple' | 'google'`).
   - No other new columns: `paymentHash` keeps its Lightning/zap meaning and becomes **nullable** (store payments have none). The store's transaction reference (Apple `transactionId`, Google `orderId`) goes in the renamed **`paymentInvoice` column** — it's the payment's invoice/receipt reference whatever the rail. Add a **partial unique index on `paymentInvoice` WHERE NOT NULL** so one transaction can never be recorded twice (BOLT11s are already unique, so zap rows are unaffected). The existing backfill script (`getInvoicesMissingPaymentInvoice`) is untouched — store rows always have `paymentInvoice` set.
3. **Store product catalog** (`…_store_products.ts`): table `storeProducts` — `id` (pk), `platform` (`'apple'|'google'`), `appIdentifier` (Google packageName / Apple bundleId the product lives in), `storeProductId` (id as created in the console), `grantsProduct` (`'mail'`), `grantsTier` (`'base'`), `active` bool, unique (platform, storeProductId). Seeded with the two mailbox rows from Phase 0. Future apps/products = new rows, no code changes. (Verification credentials stay in env — they're per developer *account*, shared across apps.)

### 1b. Stop expiring mailboxes

- `src/controllers/paymentController.ts` (both invoice handlers) and `src/controllers/mailController.ts` (`createMailboxHandler`): stop passing `expirationDate` for mail (pass `null`/omit). Keep `getExpirationFromNow()` in `controllers/utils.ts` untouched — **forms keep their 3-month expiry** (`cleanupExpiredForms` still applies to forms).
- `src/models/mails.ts` / `pendingMail.ts`: make `expirationDate` optional in types (already `?`).
- Analytics (`src/models/analytics.ts`) reads `expirationDate` — returns `null` for mail now; no change needed.
- No change to `zapReceiptHandler` / `provisionMailPurchase` expiry threading (they just forward whatever the pending row holds, now `null`).

### 1c. Extract shared provisioning

- Refactor `src/services/mailProvisioning.ts`: extract the body of `provisionMailPurchase` into `provisionMail({ pubkey, nip05, paymentHash, paymentInvoice? })` (mailbox row, nip-05 row, ledger insert, welcome mail — all idempotent as today). `provisionMailPurchase(paymentHash)` becomes a thin wrapper that loads the pendingMail row then calls `provisionMail`. Zap path behavior unchanged.

### 1d. Store payment service — `src/services/storePayments.ts` (new)

- `verifyAndProvision(input: { platform: 'apple'|'google', productId, transactionId|purchaseToken, orderId?, pubkey, nip05, tierId })` — `productId` is resolved against the **DB catalog** (1a.3): the row yields the app identifier (packageName/bundleId) to verify against and what the purchase grants (`grantsProduct`/`grantsTier`). A `tierId` contradicting the catalog row is rejected. Nothing app- or product-specific is hardcoded.
  1. **Validate purchase intent** (mirror `generateMailsInvoiceHandler`): `pubkey`/`nip05`/`tierId` present, `isReservedName(nip05)` blocked, tier exists/available.
  2. **Idempotency pre-check**: an `invoices` row with `paymentInvoice = '<store tx reference>'` exists → return `already_provisioned` (client shows success). The partial unique index (1a.2) makes duplicates impossible even under a race.
  3. **Verify with the store**:
     - **Android**: `@googleapis/androidpublisher` → `purchases.products.get({ packageName: <from catalog row>, productId, token })`; require `purchaseState == 0` (purchased); **acknowledge** immediately (`purchases.products.acknowledge`) — Play auto-refunds non-consumables not acknowledged within 3 days.
     - **iOS**: official `app-store-server-library` (npm) — verify the JWS signed transaction with `SignedDataVerifier` (Apple Root CA bundled), `transactionId`, bundleId matching the catalog row, type `NonConsumable`. Environment auto-detect: try production, fall back to sandbox (standard pattern, safe for one-time products).
  4. **Provision**: call `provisionMail({ pubkey, nip05, paymentInvoice: '<store tx reference>', provider, paymentHash: null })` — reuse idempotency (`already_provisioned`) and unique-violation tolerance already built in.
  5. **Ledger**: the shared `provisionMail` writes the `invoices` row: `provider = 'apple'|'google'`, `paymentInvoice` = store transaction reference, `paymentHash` = NULL. Lightning rows are untouched (`provider` defaults to `'lightning'`).
  6. Return `{ status: 'provisioned' | 'already_provisioned', address }`.

### 1e. Controller + route

- `src/controllers/storePaymentController.ts` (new): `verifyStorePaymentHandler` — takes body `{ platform, productId, receipt: { transactionId | purchaseToken, orderId }, pubkey, nip05, tierId }`; **uses `req.nostrPubkey` (NIP-98) as the owner**, rejecting a mismatched `pubkey` in the body (prevents buying for someone else by mistake).
- `src/routes/storePaymentsRoutes.ts` (new), mounted in `src/index.ts` at `/api/store`: `POST /api/store/verify` behind `validateNostrAuth` + the same CORS options as other routes. (No WebSocket needed — verification is synchronous; the client gets the result in the HTTP response.) Also extend `getTiersHandler` (`GET /api/tiers/mail`): include each tier's store product ids per platform from the catalog (`store: { apple, google }`), so the client never hardcodes store product ids either.

### 1f. Config, deps, tests

- `.env` additions (credentials only — app/package identifiers come from the `storeProducts` catalog per 1a.3, so onboarding a new app or product needs no env or code changes): `GOOGLE_SERVICE_ACCOUNT_JSON` (inline JSON or path), `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_PRIVATE_KEY_P8` (or path), `APPLE_VERIFY_ENV=auto|production|sandbox`. Document in README.
- `package.json`: add `@googleapis/androidpublisher`, `app-store-server-library`, `google-auth-library`.
- Tests (`jest`, mirrors existing style): `storePayments.test.ts` with mocked androidpublisher + apple verifier — happy path, idempotent re-verify, unverified/unpaid purchaseState rejected, reserved name blocked, pubkey mismatch rejected, unknown/inactive catalog productId rejected. Migration tests via `npm run migrate` on a scratch DB.

**Not changing:** zap/Lightning backend code, relays, `paymentManager`, reconcile cron — all remain for the web product.

---

## Phase 2 — Landing: IAP branch in the signup wizard

### 2a. Platform detection — `client/web/src/lib/platform.ts`

- Add `isStoreBuild()`: true when `import.meta.env.VITE_STORE_BUILD === '1'` (a **build-time** flag set by build-web.mjs, so the bundle is also correct in a plain browser for local QA). Deliberately **not** based on `isNativeApp()`: the direct Android APK is native but keeps Lightning — only the store builds flip the flag.

### 2b. IAP wrapper — `client/web/src/lib/iap.ts` (new)

- Thin wrapper over `capacitor-iap` (recommended plugin: npm `capacitor-iap`, Capacitor 7 + StoreKit 2 + Play Billing; **verify current API/docs at implementation time**, fallback: capacitor-community plugin or a minimal native bridge):
  - `fetchProduct(id)` → localized price string
  - `requestPurchase(id)` → normalized receipt `{ platform, productId, transactionId?, purchaseToken?, orderId? }`
  - `restorePurchases()` → same normalized receipts
  - No-op/stub on web (dynamic `import()` inside `isStoreBuild()` guard so web bundles never load the plugin).

### 2c. API — `client/web/src/lib/api.ts`

- Add `verifyStorePurchase(authHeader, body)` → `POST /api/store/verify` (NIP-98 signed, same error handling pattern as `generateMailInvoice`).

### 2d. Wizard — `client/web/src/components/SignupWizard.tsx`

- Steps `login → name → pay → done` stay identical. Only the **pay step** branches on `isStoreBuild()`:
  - **Store path (new `StorePay.tsx` component):** fetch product from the plugin → show localized store price → "Purchase" button → `requestPurchase` (native payment sheet) → `verifyStorePurchase` with NIP-98 → on `provisioned`/`already_provisioned` → `done`. No invoice, no QR, no WebSocket, no polling.
  - **Web path:** unchanged `InvoiceQR` + `paymentSocket`.
- Tier selection: in store mode, tiers render from the backend as today but price labels come from the store; tier → store product mapping comes from the tiers endpoint (`store` field, DB-driven per 1e) — nothing hardcoded client-side, so future tiers/apps need only console rows + catalog entries.
- **"Restore purchases"** link on the store pay step (App Review requires it): calls plugin restore → verify endpoint → jumps to `done` (backend returns `already_provisioned`).
- Error handling: user-canceled purchase (silent retry), store errors, verification failure (retry button — the purchase token stays valid for re-verification).

### 2e. Copy / compliance

- `client/web/src/pages/PrivacyPolicy.tsx`: update payment wording — Lightning on web and the direct Android APK; App Store / Google Play billing in the store builds; we never receive card/billing details (true for all paths; Lightning zap receipts remain public events, disclosed as today).
- `client/web/src/app/components/SettingsModal.tsx` line ~617 hint ("how Lightning payments work"): make payment-method neutral ("how payments work") — it's shown in the native bundle too.
- Welcome mail template (`formstr-backend/src/mailer/templates/welcome.md`): no expiry mention today — no change.

---

## Phase 3 — Mobile app wiring (both platforms)

### 3a. Android — two Gradle flavors, direct APK has zero Google

- `client/package.json`: add `capacitor-iap` (bundled but only dynamically imported in store builds); scripts: `build:web` (Lightning, unchanged) and `build:web:store` (`VITE_STORE_BUILD=1`).
- **Flavors:** `flavorDimensions "distribution"` in `app/build.gradle` with `direct` and `play` flavors. `scripts/toggle-iap.mjs` (new) runs after every `cap sync` and removes/re-adds the capacitor-iap lines from `capacitor.settings.gradle` + `capacitor.build.gradle`, so the two flavors genuinely differ at the native level.
- **Direct APK (keeps Lightning, zero Google):** `npm run build:web && npm run sync && node scripts/toggle-iap.mjs --off && ./gradlew assembleDirectRelease` — ships with **no Play Billing library, no Google Play Services, no google-services plugin, no Firebase**. The existing conditional google-services apply stays off (never commit `google-services.json`); the notifier keeps WorkManager polling (no push). Zapstore/sideload distribution otherwise unchanged.
- **Play AAB (store build, Lightning excluded):** `npm run build:web:store && npm run sync && ./gradlew bundlePlayRelease` — the only flavor containing the IAP plugin. Sequence discipline matters: always rebuild web before each artifact so the Play AAB never carries the Lightning bundle (build script prints which variant it assembled; guard release bundling to fail if `www/` was built without the store flag).
- Release signing config for Play (keystore via env vars / `keystore.properties`, not committed), establish a versionCode scheme. ProGuard: add plugin keep rules if the plugin docs require (verify). Test via internal testing track with license testers (sandbox billing, no real charge).

### 3b. iOS (new)

- `client/package.json`: add `@capacitor/ios`; `npx cap add ios` (requires macOS + Xcode; Apple Developer Program account). Set bundle id `com.formstr.mail`, combined `www/` bundle built with `build:web:store` (iOS is store-only — always the IAP bundle).
- StoreKit 2 comes through the plugin — no native code needed; add the `.storekit` configuration file for local Xcode testing, then sandbox-device testing.
- App Store submission assets: privacy policy URL (landing serves it), support URL, screenshots, privacy "nutrition labels" (data collected = pubkey + purchase record, as per the privacy policy).

### 3c. Build script

- `client/scripts/build-web.mjs`: accept a `--store` flag (or `STORE_BUILD=1` env) that adds `VITE_STORE_BUILD: '1'` to the landing build env; the default build stays Lightning. `package.json` wraps both as `build:web` / `build:web:store`.

### 3d. What "store builds exclude Lightning" means concretely

- In a store bundle (`VITE_STORE_BUILD=1`): the wizard's pay step renders `StorePay` only; `InvoiceQR` and `paymentSocket` are excluded via the platform check (lazy `import()`, so the QR-code dep isn't in the store bundle); no sats anywhere — tiers show store fiat prices.
- The direct Android APK and web bundles keep everything Lightning as today — same code path, flag simply not set.
- No Lightning/zap code exists client-side anyway (it's all backend), and the backend keeps zap code for web/APK — nothing removed there.

---

## Phase 4 — Verification

1. **Backend unit tests** (Phase 1f) green: `npm test` in formstr-backend.
2. **Lightning regression (web):** local backend + landing dev servers — full flow: tiers → invoice → (test zap via staging price) → provisioned; mailbox shows permanent (no expiry) in `GET /api/mails/mailbox`; existing DB after migration shows `expirationDate = NULL`.
3. **Android E2E:** Play internal-track build (`play` flavor) → sign up → claim name → Play sheet → purchase (tester account) → verify → provisioned → welcome mail → client shows address. Kill app mid-flow → restore purchases path. **Direct-APK regression:** assemble the `direct` flavor, confirm the Lightning wizard still works and confirm the APK contains no `com.android.billingclient` / Google services classes (apkanalyzer check).
4. **iOS E2E:** sandbox tester → same flow; Xcode StoreKit config for fast iteration; then TestFlight.
5. **Idempotency:** replay verify call → `already_provisioned`, single `invoices` row, single nip-05.
6. **Cron:** `reconcilePendingMails` untouched (web path only); confirm store payments never create pendingMails rows.

---

## Phase 5 (follow-up, out of scope today)

- **Refund handling:** Google RTDN (Pub/Sub push) + App Store Server Notifications V2 → revoke mailbox/nip-05 on refund. Needed eventually for both stores' policies.
- Store payments for **forms** (needs a native forms app or web store-payment surface; provider abstraction already supports it).
- Multi-tier store products when storage/attachment tiers ship.

## Dependency order

Phase 0 (consoles) → Phase 1 (backend) → Phase 2 (landing) → Phase 3 (mobile) → Phase 4. Phase 2's UI can be built against Phase 1 locally in parallel with Phase 0 account setup.

## Key risks

- **Plugin choice:** `capacitor-iap` must support Capacitor 7 / current Play Billing + StoreKit 2 — verify at implementation start; fallback is a thin custom native bridge (Phase 2b isolates this behind one wrapper module).
- **Apple review:** Paid Applications agreement + IAP metadata must be complete before sandbox/testflight testing works.
- **Android acknowledge window:** non-consumables must be acknowledged within 3 days or Play refunds — done in the verify path.
- **Restores are Apple/Google-account-scoped, not nostr-key-scoped:** restoring on a different nostr key provisions that key (documented behavior, matches "mailbox tied to your key").