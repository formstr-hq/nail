# Implementation Plan: Fiat Payments (Stripe + App Store + Play) for Mailstr, with Permanent Mailboxes

> Status: **Revision 2 — awaiting approval, nothing implemented.** Rev 1 (Sep 2026) planned IAP only.
> Rev 2 (Oct 13 2026) adds **Stripe**, consolidates the payment UI/logic into one module in nail (`lib/payments`), re-bases the migrations on the schema as it is today, and links a
> [UI wireframe](./wireframes/payments.html). Repos: `formstr-backend` (sibling, branch `fiat_payments`,
> currently == `main`), `nail/client/web/` (frontend), `nail/client/` (Capacitor shell).

## Revision 2 — what changed and why

| # | Change | Reason (evidence) |
|---|--------|-------------------|
| 1 | Stripe added as a third fiat rail (Checkout Sessions + webhook) | Stripe account onboarded and activated. |
| 2 | Payment UI + client logic consolidated into `lib/payments` + `components/payments` in nail (no shared package) | `SignupWizard` is 428 lines and owns invoice request, QR and socket; adding two more rails there would breach the 500-line alarm and the container/presenter rules. |
| 3 | **Channel matrix** replaces "store build vs. everything else" | See Goals. Open builds (web + direct APK) now show **Lightning + Card**; store builds IAP only. |
| 4 | **`invoices.lnInvoice` is NOT renamed** (rev 1 renamed it to `paymentInvoice`) | `GET /api/invoices` returns `SELECT *`; `InvoiceRecord.lnInvoice` is consumed by `formstr-analytics/.../PendingPaymentsTable.tsx` and the storage console (`types.ts`). A rename silently breaks both. Add `paymentRef` instead (see 1a). |
| 5 | Rev 1's "make `expirationDate` nullable" is dropped | `mails.expirationDate` / `pendingMails.expirationDate` were created with `table.dateTime(...)` — already nullable in Postgres. Only the data update remains. |
| 6 | Migration list rebuilt against the real tree (§1a) | Since rev 1: `domains`, `domain_members`, `domain_member_addresses`, `pendingDomainOrders` (workspace seats) landed on `main`; `pendingStoragePlan`/`storagePlans` + `invoices.price/price_unit` exist **unmerged** on `blossom-storage-plans`. |
| 7 | Pending-order tables gain `provider`; reconcile crons must filter on it | Both reconcile crons treat every `pendingMails`/`pendingDomainOrders` row as a zap awaiting a relay receipt. Stripe rows would be queried against relays forever. |
| 8 | `storeProducts` is seeded by script, not migration | Bundle ids differ per environment (`com.formstr.mail` vs `.debug`/staging); a migration seed would be wrong on one of them. |
| 9 | Order validation extracted once, used by Lightning, Stripe and store paths | Three callers now; rev 1 said "mirror `generateMailsInvoiceHandler`" which would be a fourth copy. |

## Goals

1. Fiat payments for mailboxes: **Stripe** (card/wallets) on open builds, **Apple IAP / Google Play Billing** in store builds.
2. **Channel matrix** (single source of truth: `lib/payments/channels.ts`):

   | Build | Lightning | Card (Stripe) | Apple/Google IAP |
   |---|---|---|---|
   | Web | ✓ (default) | ✓ | – |
   | Direct APK (Zapstore/sideload) | ✓ (default) | ✓ (hosted Checkout) | – |
   | Play Store build | – | – | ✓ Google |
   | iOS App Store build | – | – | ✓ Apple |

   Store builds contain **no Lightning and no Stripe** (Apple 3.1.1 / Play billing policy for digital goods). The direct APK has **no Google services at all** — which is also why it cannot offer Play Billing; "all payments" for it means Lightning + Card (**assumption — confirm**, Open Question 1).
3. Mailboxes become **permanent** for every rail.
4. Store (IAP) behaviour is **unchanged from rev 1** — only its code moves into `lib/payments`.
5. Products on the rail: mail (all rails), **workspace seats** (Stripe + Lightning; not IAP — a seat quantity doesn't fit a fixed store SKU), forms and storage stay Lightning-only for now. The Stripe design is product-agnostic, so each is a later adapter, not a redesign (Open Question 2).
6. Direct store/Stripe APIs; no RevenueCat.

## Current state (verified Oct 13 2026)

```
Lightning (all three products share this shape):
  client ──POST /api/generate-invoice/mail | /api/workspace/generate-invoice (NIP-98)──▶ paymentController
        pending row (pendingMails | pendingDomainOrders | pendingForm; paymentHash = zap-request pubkey)
        paymentManager.listenForPayment(hash) ──▶ zapReceiptHandler ──▶ provision* ──▶ invoices ledger
        cron */15: reconcilePendingMails / reconcilePendingDomainOrders (relay lookup by paymentHash)
  client WS /ws?hash=… ◀── {status:"paid"}
```

- Mail pay UI: `SignupWizard` (steps `login → resolving → name → pay → keys → done`), `InvoiceQR`, hosted in the mail client by `BuyAddressModal` (`.landing` scope pins the light palette).
- Mail expiry is stored, never enforced (`cleanupCrons.ts` only expires forms). Workspace members don't get `mails` rows.
- `invoices.paymentHash` is NOT NULL UNIQUE; `lnInvoice` nullable text; `/api/invoices` leaks `*`.
- `src/index.ts` registers `express.json()` globally — a Stripe webhook needs the raw body and must be mounted **before** it.

## Migration ledger (as of today)

| Migration | State |
|---|---|
| `20260406162239_mails` … `20260820120000_nip05_unique_domain` | on `main` (mails, invoices, nip05, pendingMails, nip05.domain, users, invoices.lnInvoice, unique(nip05,domain)) |
| `20260826120000_pgp_keys` | on `main` (nip05.wkd_hash, pgp_pubkey_b64) |
| `20260924140000_domains`, `20260925120000_domain_verification`, `20260925130000_domain_members`, `20260925140000_pending_domain_orders` | on `main` (workspaces/seats) |
| `20261002130000_pending_storage_plans` | **only on `blossom-storage-plans`** — adds `pendingStoragePlan`, `storagePlans`, `invoices.price`, `invoices.price_unit` |
| New, this plan: `20261014100000` … `20261014130000` | below |

**Sequencing dependency:** merge `blossom-storage-plans` first (this plan then records `price`/`price_unit` for Stripe/store rows and `pendingStoragePlan` gets the same `provider` treatment in a follow-up). If it can't merge first, move `price`/`price_unit` into our M2 and delete them from the storage migration — never both. (Open Question 3.)

---

## Phase 0 — Consoles & accounts (no code)

1. **Stripe** (account already onboarded/activated)
   - Create a **restricted API key** (Checkout Sessions: write; PaymentIntents/Charges: read) for test mode and live mode — not the root secret key.
   - Register the webhook endpoint `https://<api>/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired` (+ `charge.refunded`, `charge.dispute.created` for alerting, Phase 5). Save the signing secret per environment.
   - Dashboard: enable card + wallets; branding (logo/colors) for Checkout; statement descriptor; decide **Stripe Tax** (Open Question 4) and Radar defaults.
   - Local dev: `stripe listen --forward-to localhost:5000/api/stripe/webhook`.
   - Fiat price is configuration (env, same philosophy as `MAIL_PRICE_SATS`): no Stripe Price objects, inline `price_data`.
2. **Google Play Console** — unchanged from rev 1 (app `com.formstr.mail`, one-time product `mailbox_base`, service account + Financial data role, license testers).
3. **App Store Connect** — unchanged from rev 1 (app record, Paid Applications Agreement, non-consumable `com.formstr.mail.mailbox.base`, sandbox testers, App Store Server API key).
4. Pricing: Lightning stays sats, Stripe is `MAIL_PRICE_FIAT` (minor units) in `STRIPE_CURRENCY`, stores price in consoles. No forced parity.

---

## Phase 1 — Backend (formstr-backend)

Policy reminders (`AGENTS.md`): feature branch, each migration in its **own commit**, `npx tsc --noEmit` + `npx jest`, explicit approval before any deploy runs them, state target remote before pushing.

### 1a. Migrations (four new files, all additive except M1's data update)

1. **`20261014100000_mail_permanent.ts`** — data only: `UPDATE mails SET "expirationDate" = NULL`. Columns already nullable. **This is the one destructive step**: historical dates are lost and `down()` cannot restore them (take a `pg_dump -t mails` before deploy; `down()` is a documented no-op). Nothing reads or enforces the date, analytics returns null.
2. **`20261014110000_invoices_provider.ts`** — on `invoices`:
   - add `provider` text NOT NULL default `'lightning'` (`'lightning'|'stripe'|'apple'|'google'`; every existing row is correctly Lightning via the default);
   - add `paymentRef` text NULL — the rail's own transaction reference: Stripe `payment_intent` id, Apple `transactionId`, Google `orderId`. **Partial unique index** `ON invoices("paymentRef") WHERE "paymentRef" IS NOT NULL` so a transaction can never be ledgered twice;
   - `paymentHash` → DROP NOT NULL (store payments have no order key; Stripe rows keep their order key there). The existing UNIQUE constraint stays;
   - `lnInvoice` untouched. Code that scans for rows missing `lnInvoice` (`getInvoicesMissingLnInvoice`, `backfillInvoiceLnInvoice.ts`) gains `.where({ provider: 'lightning' })` — otherwise Stripe/store rows (no bolt11 by nature) are picked up forever.
3. **`20261014120000_pending_orders_provider.ts`** — on `pendingMails` and `pendingDomainOrders`:
   - add `provider` text NOT NULL default `'lightning'`;
   - `lnInvoice` → DROP NOT NULL (Stripe orders have none);
   - add `providerRef` text NULL (Stripe Checkout Session id) with a partial unique index where not null;
   - `paymentHash` stays NOT NULL UNIQUE and is the **order key** for every rail: the zap-request pubkey for Lightning, a server-generated 32-byte random hex for Stripe (it is already just an opaque correlation key — see `randomSha256` in `utils/zaps.ts`).
   - `pendingStoragePlan` (unmerged) gets the identical change in the storage branch's follow-up.
4. **`20261014130000_store_products.ts`** — table `storeProducts` exactly as rev 1 (`platform apple|google`, `appIdentifier`, `storeProductId`, `grantsProduct`, `grantsTier`, `active`, unique `(platform, storeProductId)`). **No seed in the migration**; `scripts/seedStoreProducts.ts` upserts per-environment rows from env.

Style note: this schema mixes camelCase (older tables, `paymentHash`) and snake_case (`domains`, `price_unit`). New columns on existing tables follow that table's style (`provider`, `paymentRef`, `providerRef`); the new table follows the newer snake style where it has multi-word columns.

Migration verification: `npm run migrate` on a scratch DB cloned from a dump of staging, then `down` for M2–M4, then up again; assert `provider='lightning'` for all legacy ledger rows.

### 1b. Stop expiring mailboxes
`paymentController.generateMailsInvoiceHandler` and `mailController.createMailboxHandler`: stop passing `expirationDate`. `getExpirationFromNow()` stays — **forms keep the 3-month expiry**. `zapReceiptHandler`/`provisionMail` just forward the (now null) pending value.

### 1c. Shared services
- `services/orderValidation.ts` (new): `validateMailOrder({ pubkey, nip05, tierId })` → `{ tier } | { error }` — reserved-name check, tier exists/available. Used by the Lightning handler, the Stripe checkout handler and store verify. (Same for workspace: `validateWorkspaceOrder({pubkey, domain, seats})` extracted from `generateWorkspaceInvoiceHandler`: owner-only, not suspended, 1–1000 seats.)
- `services/mailProvisioning.ts`: extract `provisionMail({ pubkey, nip05, provider, paymentHash?, paymentRef?, lnInvoice?, price?, priceUnit? })`; `provisionMailPurchase(paymentHash)` becomes the thin pending-row wrapper. `createInvoice` records `provider` + `paymentRef`.
- `workspaceProvisioning.provisionWorkspaceOrder(paymentHash)` already keys on the order key and is idempotent via `markDomainOrderGranted` — reused as is; it does **not** write an `invoices` row today (the zap handler does), so extract that ledger write into the provisioning function for the non-zap callers.

### 1d. Stripe — `services/stripePayments.ts`, `controllers/stripeController.ts`, `routes/stripeRoutes.ts` (new)

Deps: `stripe` (official Node SDK, pin `apiVersion`). Env (credentials + prices; Stripe is disabled and `fiat` omitted from tiers when `STRIPE_SECRET_KEY` is unset; once set, missing prices are a startup error like the sats ones): `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CURRENCY`, `MAIL_PRICE_FIAT`, `WORKSPACE_SEAT_PRICE_FIAT`.

- **`POST /api/stripe/checkout`** (NIP-98; `req.nostrPubkey` is the owner, body pubkey must match). Body `{ product: 'mail'|'workspace', tierId, nip05 | domain+seats, uiMode: 'embedded'|'hosted' }`.
  1. `validate*Order` (1c). Amount is **derived server-side** from the tier/seat price — never from the request.
  2. `orderKey = randomSha256()`; insert the pending row `{ provider:'stripe', paymentHash: orderKey, lnInvoice: null }`.
  3. `stripe.checkout.sessions.create({ mode:'payment', ui_mode, client_reference_id: orderKey, metadata:{ product, orderKey }, line_items:[price_data × quantity], expires_at: now+30m, return_url | success_url+cancel_url }, { idempotencyKey: orderKey })`.
  4. Store `providerRef = session.id`. Respond `{ orderKey, clientSecret | url, amount, currency }`.
- **`POST /api/stripe/webhook`** — mounted with `express.raw({ type:'application/json' })` **before** `app.use(express.json())` in `src/index.ts`; `stripe.webhooks.constructEvent(raw, signature, STRIPE_WEBHOOK_SECRET)`; no NIP-98 (Stripe-signed).
  - `checkout.session.completed` with `payment_status==='paid'` (or `async_payment_succeeded`): load the pending row by `client_reference_id`; **verify** `session.id === providerRef`, `amount_total` and `currency` equal the recomputed expectation, `mode==='payment'`; then call the same `provisionMail` / `provisionWorkspaceOrder` with `provider:'stripe'`, `paymentRef = payment_intent`, `price = amount_total`, `priceUnit = currency`.
  - Provisioning failure → **HTTP 500** so Stripe retries (exponential backoff for ~3 days) — the webhook is its own reconciler. Unknown events → 200. Duplicate deliveries are no-ops (partial unique on `paymentRef`, `markDomainOrderGranted`, nip05 exists check).
  - `…expired` / `async_payment_failed`: delete the pending row.
- **`GET /api/orders/:orderKey/status`** → `{ status: 'pending'|'paid'|'expired' }`, unauthenticated: the key is 256-bit random (a capability) and the response carries nothing else. Paid = an `invoices` row with that `paymentHash`; pending = pending row younger than 30 min; else expired. The client polls this (2 s, bounded) after Checkout reports done. Lightning keeps its WebSocket.
- **`GET /api/payments/config`** → `{ stripe: { enabled, publishableKey } , lightning: { enabled } }` so key rotation and test/live never need a client rebuild.
- **Cron `scripts/reconcileStripeOrders.ts`** (*/5): for pending rows with `provider='stripe'` older than 2 min, `sessions.retrieve`; paid → provision, expired → delete; anything older than 24 h deleted. Add to `cleanup-crontab`. **Existing `reconcilePendingMails.ts` / `reconcilePendingDomainOrders.ts` add `provider='lightning'` to their row selection.**
- Refunds/disputes: Phase 5. Until then `charge.refunded` / `charge.dispute.created` are logged loudly and (if mail is configured) emailed to `ADMIN`; no automatic revocation.

### 1e. Store IAP — as rev 1
`services/storePayments.ts` + `controllers/storePaymentController.ts` + `POST /api/store/verify` (NIP-98, `req.nostrPubkey` is owner, catalog-resolved product, Apple JWS via `app-store-server-library`, Google `purchases.products.get` + **acknowledge**, idempotent via `paymentRef`, ledger `provider='apple'|'google'`, `paymentHash` NULL). Deps `@googleapis/androidpublisher`, `app-store-server-library`, `google-auth-library`; env `GOOGLE_SERVICE_ACCOUNT_JSON`, `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_PRIVATE_KEY_P8`, `APPLE_VERIFY_ENV`. Mail only. The only deltas from rev 1: uses `paymentRef` (not `paymentInvoice`) and `validateMailOrder`.

### 1f. Tiers endpoint
`getMailTiers()` / `getWorkspaceTiers()` add optional `fiat: { currency, amountMinor }` (when Stripe enabled) and `store: { apple, google }` (from `storeProducts`). `priceSats` unchanged → old clients unaffected. Clients render by the build's methods; the backend serves every rail to every client (it can't tell a store build from a browser, and store-policy compliance is a client build property).

### 1g. Tests (jest, existing style)
`stripePayments.test.ts` (mock `stripe`): checkout creates pending row + session with server-derived amount; webhook happy path; bad signature → 400; amount/currency/session-id mismatch rejected; duplicate delivery idempotent; provisioning error → 500; expired session cleans pending row; pubkey mismatch → 403. `storePayments.test.ts` as rev 1. Extend the reconcile-script tests to assert Stripe rows are skipped. Migration test on scratch DB (above).

**Not changing:** zap listener, relays, `paymentManager`, forms/storage payment paths.

---

## Phase 2 — Frontend payments module (nail, `client/web/src/lib/payments/`)

The payment logic stays **inside nail** (no shared package in this revision). It is still pulled out of `SignupWizard` into one cohesive module so the wizard stays thin (repo rules 2, 3, 8) and so a later extraction to common-packages, if wanted, is a move rather than a rewrite.

```
client/web/src/lib/payments/
  channels.ts     CHANNEL_METHODS matrix + methodsForBuild() (+ test)
  client.ts       tiers, payments config, lightning invoice, stripe checkout, store verify, order status
  status.ts       pollOrderStatus (bounded), watchLightning (existing WS)
  iap.ts          dynamic import of the Capacitor IAP plugin (fetchProduct / requestPurchase / restore)
client/web/src/components/payments/
  PaymentSheet.tsx   picks the method UI; renders MethodPicker when >1 method
  MethodPicker.tsx   segmented control (wireframe §2), Lightning first
  LightningPay.tsx   today's InvoiceQR, moved unchanged
  StripePay.tsx      Embedded Checkout (hosted via @capacitor/browser in a native shell)
  StorePay.tsx       purchase + Restore purchases
```

- **Lightning first, everywhere.** `CHANNEL_METHODS` orders open builds `['lightning','stripe']`; the picker lists Lightning first and **defaults to it** (a remembered choice, `zustand/persist` key `mailstr.pay.method`, overrides the default). Price rows show sats first, fiat second.
- **Dead-code elimination is the compliance mechanism.** `PaymentSheet` receives its methods from `lib/payments/methods.ts`, which composes them behind the build-time constant (`import.meta.env.VITE_STORE_BUILD`) with **dynamic imports per rail**, so Rollup drops the Lightning/QR and Stripe chunks from store bundles (rev 1 §3d requirement, preserved). A runtime switch would defeat this.
- Lightning's invoice and Stripe's session are requested **lazily on selection**: opening the sheet on Lightning never creates a Stripe session, and choosing Card never creates a Lightning invoice or relay listener.
- Stripe: `@stripe/stripe-js` + `@stripe/react-stripe-js` (rule 13, proven libs), loaded only inside `StripePay`; publishable key from `/api/payments/config`.
- Tests: vitest for `channels`, `client`, `status`; component tests for the picker and each rail against a mocked client; Playwright e2e for the wizard (Phase 5).

## Phase 3 — Wizard integration

1. `lib/platform.ts`: `isStoreBuild()` (`VITE_STORE_BUILD === '1'`, build-time, **not** `isNativeApp()`).
2. `SignupWizard.tsx` (428 lines, over the 300 target): the pay step becomes `<PaymentSheet product="mail" order={{ tierId, nip05 }} onPaid={() => setStep('keys')} />`; delete `requestInvoice`, `invoice` state, `generateMailInvoice`, `paymentSocket`, `MailInvoice` from `lib/api.ts` and the old `InvoiceQR` (rule 14). Extract the login effect into `useSignupLogin` in the same change to get under the size alarm.
3. `NameStep`: price row per wireframe §1 (**sats first, then fiat** on open builds; store price only in store builds); the CTA stops naming a method and stops saying "Preparing invoice…".
4. `BuyAddressModal` / `.landing` scoping unchanged.
5. `SettingsModal` hint + `PrivacyPolicy.tsx`: payment-method-neutral wording; disclose Stripe as processor (we never receive card data), Lightning zap receipts stay public, store billing in store builds.
6. Per repo rule 15, log the ADR ("DCE-based channel exclusion") in `docs/Session-Log.md`.
7. Other apps that copy this UI today (storage console, forms support button) are untouched; they keep their own copies until someone decides to share the module.

## Phase 4 — Mobile wiring

- **Build flag/script**: as rev 1 §3c (`build:web` open, `build:web:store`).
- **Android flavors** (`direct`, `play`) and `toggle-iap.mjs`: as rev 1 §3a. `direct` ships **no Play Billing, no Play Services, no Firebase**; Stripe there is hosted Checkout in a Custom Tab (just the system browser) — needs `@capacitor/browser` and a `com.formstr.mail://pay-return` (or https app-link) intent filter. Stripe's Android SDK is **not** used (keeps the zero-Google guarantee provable).
- **iOS**: as rev 1 §3b, store-only bundle.
- Compliance check in the build: the store bundle must not contain `lightning:`, `qrcode`, `js.stripe.com`, `@stripe`; the direct APK must not contain `com.android.billingclient` / Google services (apkanalyzer).

## Phase 5 — Verification

1. Backend: `npx tsc --noEmit`, `npx jest`; migrations up/down/up on a staging dump (§1a).
2. **Stripe, test mode**: `stripe listen`; test cards `4242…` (success), `4000 0000 0000 9995` (decline), 3DS card; `stripe trigger` for refund/dispute logging. Webhook retry: kill backend mid-delivery, confirm Stripe redelivers and the result is one mailbox, one ledger row.
3. **Lightning regression (web)**: full flow still works with the picker present; legacy ledger rows read `provider='lightning'`; `/api/invoices` response still has `lnInvoice`; both existing reconcile crons skip Stripe rows.
4. Wizard e2e (Playwright, mock backend): picker shows Lightning (default) then Card on open build, store-only on store build; Lightning invoice not created until selected; success path through `GET /api/orders/:key/status`.
5. Android: `play` internal-track purchase + restore; `direct` APK: Lightning, Stripe hosted round-trip with the app killed mid-checkout (order status resumes); apkanalyzer check. iOS sandbox + TestFlight.
6. Idempotency: replay webhook / store verify → single ledger row, single nip05.

## Phase 6 (follow-up, out of scope)
Refund handling across rails (Stripe `charge.refunded`/disputes, Google RTDN, App Store Server Notifications V2 → revoke mailbox/seats); Stripe for forms/storage (storage is a 30-day renewing plan — decide one-off vs Subscriptions); Stripe Tax if chosen; multi-tier store SKUs.

## Dependency order
Phase 0 → merge `blossom-storage-plans` → Phase 1 → Phase 2 (can start against mocks once the §1d/§1e contracts are agreed) → Phase 3 → Phase 4 → Phase 5.

## Open questions
1. **Direct APK "all payments"** = Lightning + Card (store billing impossible outside Play). Correct?
2. **Stripe scope v1**: recommend mail + workspace seats. OK, or mail only?
3. **Storage branch ordering**: merge `blossom-storage-plans` first (recommended), or fold `price`/`price_unit` into M2?
4. **Stripe Tax / currencies**: single currency (`STRIPE_CURRENCY`) at launch, tax off unless you want it on?
5. **Mailbox date wipe (M1)**: OK to null existing `mails.expirationDate`, with a pre-deploy table dump?

## Key risks
- **Embedded Checkout inside the Capacitor WebView** is unverified → hosted Checkout is the fallback already designed in; decide after a device test.
- **Webhook ordering**: browser may report done before the webhook lands → status polling, bounded at 2 minutes then "still confirming — you'll get your mailbox shortly" (cron + Stripe retries finish the job).
- **Plugin choice** for IAP, **Apple review prerequisites**, **Android acknowledge window**, **restores are store-account-scoped** — unchanged from rev 1.
- **Policy**: Stripe must never ship in a store bundle; enforced by DCE + bundle grep (Phase 4), not by convention.
