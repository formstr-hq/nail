# Implementation Plan: Fiat Payments (Stripe + App Store + Play) on a Unified Invoices Table

> Implementation status (Oct 18 2026): **backend Deploy A core is implemented** on `formstr-backend` branch `fiat_payments` (migrations M1–M10, shared db, unified invoices/product models, `fulfilInvoice`, order validation, Lightning flow for all four products, single Lightning reconciler, serializer/analytics, admin alerts). **Not started:** Stripe + fiat quotes (1f), store IAP (1g, 1h), Deploy B migrations M11–M13, the nail client (Phases 2–4), store-bundle guard. Notes from implementing: knex's `setNullable` *drops* NOT NULL and `dropNullable` *adds* it (M1a uses `setNullable`, M13 will use `dropNullable`); the partial unique index predicate needs `knex.whereRaw("status = 'active'")` because a bound `where()` is emitted with an unbound `?`; the full pre-existing 1j consumer edits (`invoice ?? lnInvoice`) are in formstr-analytics and the storage console working trees, uncommitted.
>
> Original status: **awaiting approval, nothing implemented.** Verified against `formstr-backend` `origin/main` (`3d15ef0`) on Oct 18 2026.
> Repos: `formstr-backend` (sibling repo; work branches off `main`), `nail/client/web/` (frontend),
> `nail/client/` (Capacitor shell). UI wireframe: [wireframes/payments.html](./wireframes/payments.html).

## Goals

1. Fiat payments for mailboxes and workspace seats: **Stripe** (card/wallets) on open builds, **Apple IAP / Google Play Billing** in store builds. **The price is fixed in sats.** A Stripe payment's fiat amount is that sats price converted at quote time into the currency the buyer picks, plus Stripe's fees, so the net received equals the converted amount (see Currencies and fiat pricing). No exchange rate and no sats price is stored in the database.
2. **Channel matrix** (single source of truth: `lib/payments/channels.ts`):

   | Build | Lightning | Card (Stripe) | Apple/Google IAP |
   |---|---|---|---|
   | Web | ✓ (default) | ✓ | – |
   | Direct APK (Zapstore/sideload) | ✓ (default) | ✓ (hosted Checkout) | – |
   | Play Store build | – | – | ✓ Google |
   | iOS App Store build | – | – | ✓ Apple |

   Store builds contain **no Lightning and no Stripe** (Apple 3.1.1 / Play billing policy for digital goods). The direct APK has **no Google services at all**, so it cannot offer Play Billing; its payment methods are Lightning + Card (decided).
3. Mailboxes become **permanent** for every payment method. The expiry column is removed.
4. **One `invoices` table** is the record of every purchase, from "order placed" (`pending`) to "paid" (`fulfilled`), for **all four products** (mail, workspace, form, storage) and every payment method. What was bought lives in a product table, which the invoice points at with `product` + `product_id`. Every product row carries a `status` that stays `inactive` until its invoice is fulfilled. All four pending tables are retired.
5. Workspace seats are sold in stores as **fixed seat packs** (consumable IAPs, bought as many times as needed).
6. Direct store/Stripe APIs; no RevenueCat.

## Scope

| Product | Product table | Payment methods in this plan | Notes |
|---|---|---|---|
| **Mail** | `mails` | Lightning, Stripe, Apple, Google | `pendingMails` retired. In stores: one non-consumable per mailbox |
| **Workspace seats** | `workspace_orders` (new) | Lightning, Stripe, Apple, Google | `pendingDomainOrders` retired. Lightning/Stripe sell any quantity; stores sell fixed packs as consumables |
| **Forms** | `forms` | Lightning | `pendingForms` retired. Stripe/IAP for forms is a follow-up (decided) |
| **Storage** | `storagePlans` | Lightning | `pendingStoragePlan` retired. Stripe/IAP for storage is a follow-up; it's a renewing plan, so one-off vs subscription needs deciding first |

Every product uses the same order → invoice → fulfilment path. Forms and storage only lack the extra payment methods, and those can plug in later without touching the data model.

## Current state (`origin/main` `3d15ef0`, Oct 18 2026)

```
Lightning (all four products share this shape):
  client ──POST /api/generate-invoice/:product | /api/workspace/generate-invoice──▶ paymentController
        pending row (pendingMails | pendingDomainOrders | pendingForms | pendingStoragePlan)
          paymentHash = zap-request pubkey, lnInvoice = BOLT11
        paymentManager.listenForPayment(hash) ──▶ handleZapReceipt ──▶ provision* ──▶ invoices (ledger insert)
        cron */15: reconcilePendingMails / reconcilePendingDomainOrders / reconcilePendingStoragePlans (forms: none)
  client WS /ws?hash=… ◀── {status:"paid"}
```

- `invoices` is a **ledger of paid purchases only**: one row inserted at fulfilment. Columns: `id`, `product`, `pubkey`, `paymentHash` (NOT NULL UNIQUE), `lnInvoice` (nullable), `price`, `price_unit` (nullable), `created_at`, `updated_at`.
- Ledger rows don't point at what they paid for:
  - Mail: analytics guesses the address by pairing a pubkey's invoices with its `nip05` rows in creation order (`attachMailAliases`).
  - Workspace: the domain is found by joining `pendingDomainOrders` on `paymentHash` (granted orders are never deleted).
  - Storage: matched through `storagePlans.payment_hash`.
  - Forms: no link at all, and the ledger `pubkey` is the **form's** pubkey, not the buyer's (`zapReceiptHandler.createForm` returns `pending.pubkey`).
- **Paid but name already taken** (mail address or form slug): whether a name is free is only checked by the client, which reads `.well-known/nostr.json` for mail. Neither invoice handler checks availability. When a second buyer pays for a name that's already taken:
  - Mail: `provisionMailPurchase` returns `already_provisioned` without checking whose address it is. `handleZapReceipt` then has no pubkey and returns early, so no ledger row is written and no WebSocket message is sent.
  - Forms: `createFormFromZap` returns "Slug already in use". The ledger row is still written, but under the form's pubkey, and no form is created.

  In both cases the payer gets nothing.
- Storage holds its claim across an external call: it inserts `storagePlans` as the claim, calls the orchestrator (`assignEntitlement`), and deletes the claim again if that call fails. The orchestrator's `EntitlementGrant` is keyed by `payment_hash` (`@id`), so re-assigning the same purchase is idempotent.
- Cleanup: `cleanupOldPendingForms` deletes pending forms older than 1 hour; `cleanupExpiredForms` **deletes** forms past their 3-month `expirationDate`; mail/workspace/storage pending rows are never cleaned up.
- Mail expiry (`mails.expirationDate`, +3 months) is stored but never enforced.
- `/api/invoices` and `/api/invoices/all` return `SELECT *`. Two consumers read `lnInvoice` / `paymentHash` from it: `formstr-analytics` (`PendingPaymentsTable.tsx` via `/api/analytics`) and the storage console (`packages/console/src/types.ts`, `pages/Dashboard.tsx`).
- `src/index.ts` registers `express.json()` globally, but a Stripe webhook needs the raw body, so it has to be mounted **before** that.
- Every model file opens its own `knex()` pool, so no transaction can span two models today.

### Migration ledger

Verified against `origin/main` at `3d15ef0` ("review fixes"), Oct 18 2026. `origin/dev` (`d6eb5ec`) is one commit behind `main`, and the local `dev` checkout is identical to `origin/main`.

| Migration | Adds | Where |
|---|---|---|
| `20250618140726_create_forms_table` | `forms` | `main` |
| `20250618140736_create_pending_forms_table` | `pendingForms` | `main` |
| `20260406162239_mails` | `mails` | `main` |
| `20260406162247_invoices` | `invoices` (`product`, `pubkey`, `paymentHash`) | `main` |
| `20260406164007_nip05` | `nip05` | `main` |
| `20260406175345_pending_mails` | `pendingMails` | `main` |
| `20260705000001_nip05_domain` | `nip05.domain` | `main` |
| `20260818120000_create_users_table` | `users` | `main` |
| `20260819120000_add_ln_invoice_to_invoices` | `invoices.lnInvoice` | `main` |
| `20260820120000_nip05_unique_domain` | `UNIQUE(nip05, domain)` | `main` |
| `20260826120000_pgp_keys` | `nip05.wkd_hash`, `nip05.pgp_pubkey_b64` | `main` |
| `20260924140000_domains` … `20260925140000_pending_domain_orders` | `domains`, verification, `domain_members`, `domain_member_addresses`, `pendingDomainOrders` | `main` (#41) |
| `20261002130000_pending_storage_plans` | `pendingStoragePlan`, `storagePlans`, `invoices.price`, `invoices.price_unit` | `main` (#44) |
| This plan: `20261020100000` … `20261020100900` (expand), `20261103100000` … `20261103100200` (contract) | see Migrations | new |

Every existing migration is on `main`, and this plan branches off `main`.

---

## Target data model

### Principles

1. **`invoices.status` is the only record of whether a purchase was paid.** `pending` = order placed, money not confirmed. `fulfilled` = paid. No other values.
2. **Every product row has a `status`: `inactive` until its invoice is fulfilled and the product is provisioned, then `active`.** The product row is created when the order is placed, together with its pending invoice and in the same transaction. It holds what was bought (address, slug, plan, domain, seats). The invoice holds the money side (who paid, how much, which payment method, the payment's own references). Anything that reads a product (mailbox lookup, form by slug, current storage plan, analytics) reads `active` rows only. A form that expires also goes back to `inactive`.
3. **Nothing is deleted.** An abandoned order is a `pending` invoice past its `expires_at`, with its product row still `inactive`. "Abandoned" is worked out from those two facts, not stored as a separate status, and the rows stay for analytics. Reconcilers stop looking at them after a grace period.
4. **One invoice per product row**: unique on `(product, product_id)`.
5. **Fulfilment is one transaction**: flip the invoice `pending → fulfilled` (a conditional update, so exactly one caller can win), do the product's provisioning writes, then flip the product row to `active`. Either everything commits or nothing does. Side effects (welcome/storage mail, WebSocket notification) run after commit.
6. **Paid but not provisionable** (name taken, storage plan no longer applies, domain gone): the invoice commits as `fulfilled` (the money arrived), the product row stays `inactive`, the client gets an explicit error, and **every admin gets an alert mail** (1l). Analytics also lists these rows as "paid, not provisioned".
7. **All new tables and columns are snake_case.** The old camelCase payment columns on `invoices` (`paymentHash`, `lnInvoice`) get replaced, not renamed: add the new column, copy the data, drop the old one. `mails.expirationDate` and `storagePlans.payment_hash` are dropped outright. Existing table names (`forms`, `storagePlans`) and the forms columns that stay meaningful (`viewKey`, `expirationDate`) are left alone.

### Relationships

```
                       product='mail'        ┌──────────────────┐ nip05_id  ┌─────────┐
                    ┌─ product_id ─────────▶│ mails            │──────────▶│ nip05   │
                    │                        └──────────────────┘           └─────────┘
┌──────────────┐    │  product='workspace'   ┌──────────────────┐ domain_id ┌─────────┐
│   invoices   │────┼─ product_id ─────────▶│ workspace_orders │──────────▶│ domains │
│ (pending /   │    │                        └──────────────────┘           └─────────┘
│  fulfilled)  │    │  product='form'        ┌──────────────────┐
└──────────────┘    ├─ product_id ─────────▶│ forms            │   (unique slug among active)
                    │                        └──────────────────┘
                    │  product='storage'     ┌──────────────────┐   invoice.payment_hash ─▶ orchestrator
                    └─ product_id ─────────▶│ storagePlans     │   EntitlementGrant.payment_hash
                                             └──────────────────┘
   every product row: status inactive → active

store_products ── catalog the store-verify endpoint resolves a SKU against
                  (grants_product = mail | workspace, grants_quantity = seats per pack)
```

`product_id` isn't a database foreign key, because it points at a different table depending on `product`. The pair is unique, and the models resolve it.

### What each payment method writes

| Column | Lightning | Stripe | Apple / Google |
|---|---|---|---|
| `provider` | `lightning` | `stripe` | `apple` / `google` |
| `payment_hash` | zap-request pubkey (what receipts carry in `#p`; also the WebSocket key and the orchestrator grant key for storage) | Checkout Session id (`cs_…`): the order, set right after the session is created; what the webhook matches and the client polls | `NULL` (no order is placed before the purchase) |
| `invoice` | BOLT11 issued to the payer | PaymentIntent id (`pi_…`), set when the session completes (`NULL` while pending) | Apple `transactionId` / Google `orderId` (the `purchaseToken` when Play gives no `orderId`, e.g. promo-code redemptions) |
| `price`, `price_unit` | sats, `sats` | the amount charged in the buyer's chosen currency, in minor units: Checkout `amount_subtotal` (before any tax) and its `currency`. It is the grossed-up quote amount, fixed when the invoice is created | Apple: the transaction's `price` (converted from milli-units to minor units) and `currency`, i.e. the buyer's local price, gross, before Apple's commission. Google: `NULL` (the purchase API doesn't report a price) |
| `expires_at` | BOLT11 expiry | Checkout Session `expires_at` (30 min) | `NULL` |

Two columns, two meanings, the same for every payment method. Both are unique:
- **`payment_hash` is the order key**: what an incoming payment notification is matched against, and what the client watches.
  - Lightning: the zap-request pubkey.
  - Stripe: the Checkout Session id. A **Checkout Session** (`cs_…`) is the checkout page/order we create before payment.
  - Stores: `NULL`, because there's no order before the purchase.
- **`invoice` is the payment**: the payment method's own id for the money that moved (or, for Lightning, will move).
  - Lightning: the BOLT11.
  - Stripe: the **PaymentIntent** (`pi_…`), which is the actual charge. Checkout creates it when the buyer submits payment, so it's recorded from `session.payment_intent` at fulfilment. Refund and dispute events carry the PaymentIntent, so they map straight to the invoice row with no extra API call.
  - Stores: the store transaction / order id. Its uniqueness is what makes a replayed store verify a no-op.

So Stripe stores both ids with no extra column: the session where Lightning keeps its zap key, the PaymentIntent where Lightning keeps its BOLT11. The column keeps the name `payment_hash` because the zap, WebSocket and storage-grant code all use that name.
- **Caveat for later**: the storage orchestrator only accepts a 64-hex `paymentHash` for payment grants, so Stripe for storage (a follow-up) would need the orchestrator to accept session ids, or a hex grant key derived from the session id.
- **Lightning**: the zap receipt id isn't stored. The BOLT11 is matched against the receipt during validation.

---

## Currencies and fiat pricing

| Payment method | How the price and currency work |
|---|---|
| Lightning | Fixed sats price (`MAIL_PRICE_SATS`, `WORKSPACE_SEAT_PRICE_SATS`). No quote needed. |
| Stripe (Managed Payments) | The sats price is converted into the **currency the buyer picks from a list**, grossed up for Stripe's fees, quoted by the backend, accepted by the buyer, then charged. That currency becomes the session's **integration currency**. Under Managed Payments Stripe's Adaptive Pricing is always on and can't be turned off (the `adaptive_pricing` parameter isn't allowed), so Checkout may also show the buyer their local currency; see "Stripe Managed Payments" below. |
| Apple / Google | The stores price every country from the base price set in the console and show a localized price string. Apple's charged local price is recorded in `price` / `price_unit`. |

**Nothing about the conversion is stored.** The database keeps only what it keeps today: `invoices.price` (the amount charged, in minor units) and `invoices.price_unit` (the currency). The sats price lives in config. The exchange rate exists only in a short cache and inside the signed quote the client holds.

### Stripe Managed Payments (merchant of record)

Decided: card payments go through [Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments/how-it-works.md). Stripe is the merchant of record: it calculates, collects, files and remits indirect tax (VAT, GST, sales tax) in 80+ countries, handles fraud, disputes and transaction-level support, and sends the receipts. (Checked against Stripe's docs on Oct 18 2026; items marked *verify* need a sandbox or Stripe confirmation.)

**What changes in our design**
- **Tax is Stripe's job, not ours.** We drop `automatic_tax` and the Stripe Tax decision (the parameter isn't allowed). Each line item carries `product_data.tax_code`, which must be one of Stripe's approved digital-product codes (the accountant picks: e.g. `txcd_10000000` electronically supplied services, or the SaaS codes, and business vs personal use for workspace seats).
- **Pricing is tax-exclusive.** We set `tax_behavior: 'exclusive'` on the price, so the quoted `G` is the pre-tax price and Checkout adds tax on top. The Dashboard setting "tax included in prices" stays off. Stripe withholds the tax from what it pays out, so we net `G` minus fees. The webhook still checks `amount_subtotal`, which excludes tax. Our UI says "plus applicable tax" next to the card price.
- **Unsupported session parameters** are removed: `adaptive_pricing`, `automatic_tax`, `tax_id_collection`, `payment_method_types` / `excluded_payment_method_types` / `payment_method_configuration` (Stripe picks dynamic methods), `invoice_creation`, `payment_intent_data.receipt_email` and the statement-descriptor fields, shipping and Connect fields. Enable with `managed_payments: { enabled: true }`; API version `2025-03-31.basil` or later; accept Managed Payments' terms in the Dashboard. Checkout collects the buyer's name and billing address itself (needed for tax). Both the hosted page and the embedded page are named as supported Checkout integrations; custom domains on Checkout are not. *verify embedded in the sandbox.*
- **Currency interplay (decision, see Decisions).** Adaptive Pricing is always on, so Stripe localizes a price shown in our integration currency into the buyer's local currency when it differs, and the buyer pays Stripe's 2 to 4% conversion fee on top unless they choose to pay in the integration currency. If the buyer picks EUR from our list but Checkout detects a UK buyer, Checkout may show GBP. Defaulting our list to the buyer's locale currency makes this rare; the alternative is a single integration currency (USD) with no list for Card. *verify with `test+location_XX@example.com` emails.*
- **Fees are higher and must be re-checked.** Managed Payments adds its own fee on top of standard processing. Third-party articles say about 3.5% extra (so roughly 6.4% + 30¢ on a US card); I could not retrieve Stripe's own number. `STRIPE_FEES` must use Stripe's real Managed Payments rates, and the sandbox balance transaction (`fee`, plus the reports' `withheld_tax` and `fee_net_of_withheld_tax` columns) is how to confirm the net equals `N`. With fees this high the card price is noticeably above the Lightning price (Decisions).

**Buyer-facing effects**
- Checkout and receipts show Link as the merchant ("sold through Link"); receipts and invoices come from Link, not from us; the card statement shows `LINK.COM*`. The buyer can manage orders on link.com. Our own welcome mail is unaffected.
- Buyers in a few sanctioned countries can't buy (e.g. China, Cuba, Iran, Russia, Syria, North Korea).

**Refunds, disputes, support**
- Stripe handles disputes (the dispute fee still applies) and may refund within 60 days on its own, including when it escalates a support case to our Dashboard support e-mail and gets no answer within 48 hours. Refunds include the buyer's tax; in some jurisdictions the withheld sales tax is deducted from our balance.
- So **refunds not started by us become routine**. The webhook's `charge.refunded` alert (1l) is the signal. Revoking a refunded mailbox or seats automatically moves from "follow-up" to something to decide (Decisions).
- Keep the Dashboard support e-mail correct and monitored.
- On a customer's data-deletion request Stripe deletes the Customer, PaymentIntent and Charge objects from our account; our `invoices` row survives (it only holds the PaymentIntent id string).

**Eligibility to keep**: a direct (non-Connect) account in a supported location (the US is), fully automated digital products (a mailbox and seats are), and a low long-term dispute rate.

**Not covered**: Lightning payments (no tax handling) and store purchases (the stores handle tax).

### The flow (Stripe)

1. **Pick a currency.** The buyer chooses Card and selects a currency from the list the backend returns (`GET /api/payments/currencies`).
2. **Get the price.** The client calls `POST /api/quotes { currency, product, tierId | seats }`. The backend converts the sats price, grosses it up for Stripe's fees, and returns `{ currency, exponent, amountMinor, expiresAt, quoteToken }`.
3. **Accept it.** The client shows the amount and its expiry. When the buyer accepts, the client calls `POST /api/stripe/checkout` with the `quoteToken` and the order details (address / domain and seats).
4. **Pay.** The backend verifies the token, creates the inactive product row and the pending invoice (`price` = the quoted amount, `price_unit` = the currency), creates the Checkout Session with exactly that currency and amount, and the client mounts Checkout.
5. **Fulfil.** The Stripe webhook checks that what was paid equals what the invoice was created for, then fulfils (Principle 5).

If the quote has expired, or the order doesn't match the token, checkout returns **409** with a reason, and the client shows a fresh quote for the buyer to accept again. A buyer is never charged an amount they haven't been shown.

### The quote token (stateless)
- An HMAC-signed token (`QUOTE_SECRET`) holding `{ product, tierId | seats, sats, currency, amountMinor, exp }`. The sats value and the amount are **inside the token, not in the database**.
- At `POST /api/stripe/checkout` the backend checks the signature and `exp` (`QUOTE_TTL_SECONDS`, default 600), that the order matches the token's product and quantity, **and that the token's sats equals the product's current configured sats price**. So a price change in config between quote and checkout invalidates old quotes (409).
- The price is then locked into the invoice. The Checkout Session lives 30 minutes (Stripe's minimum), so a buyer who accepted a quote has at most about 40 minutes of exposure to rate moves, and the amount they pay can't change after they accept.
- The token is also checked against the order's **owner**: checkout is NIP-98 authenticated, and the quote carries no identity, so a shared token only gets someone else the same price.

### Rate feed — `services/fxRate.ts`
- Rates come from **BTC/<currency> pairs on public exchange tickers** (candidates: Coinbase, Kraken, Bitstamp; verify their endpoints, rate limits and pair coverage when implementing). The backend takes the **median of at least two sources** and refuses a quote when fewer than two agree within a tolerance (`FX_MAX_DEVIATION`, default 1%).
- Cached for about 60 s (`FX_CACHE_SECONDS`). A rate older than `FX_MAX_AGE_SECONDS` (default 600) is **not used**: card quoting returns 503 and the client offers Lightning only. A rate that moves more than a sanity bound from the previous one is rejected until sources agree.
- The currency list is `FIAT_CURRENCIES` (config) ∩ the currencies the feed quotes ∩ Stripe's supported presentment currencies. Each entry carries its minor-unit exponent (0 for JPY/KRW, 2 for most), because Stripe amounts are in the smallest unit.
- The rate is logged at info level with the quote (for debugging and audit trail in logs), **not persisted**.

### Conversion and the fee gross-up — `services/fiatQuote.ts`
Let `N` be the intended amount in the buyer's currency, in minor units, and `G` the amount charged.

1. `N = ceil( sats × rate(BTC→currency) ÷ 1e8 × 10^exponent )`. For seats, the **total** sats (`seats × seat price`) is converted once, never per seat, so rounding can't drift.
2. Stripe's fee on a charge of `G` is `round(P × G) + F`, with `P` the percentage and `F` the fixed fee in that currency's minor units.
3. Choose the smallest `G` with `G − (round(P × G) + F) ≥ N`. Start from `G = ceil((N + F) ÷ (1 − P))` and bump by one minor unit while the check fails.
4. If `G` is below Stripe's minimum charge for the currency, use the minimum (see Stripe's [minimums](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts)). The buyer then pays slightly more than the fee-covered price, which is fine, and the quote notes `minimumApplied`.

Worked example (USD, `P = 2.9%`, `F = 30`): `N = 500` ($5.00) → `G = ceil(530 ÷ 0.971) = 546`; fee = `round(15.83) + 30 = 46`; net = `546 − 46 = 500` ✓.

Fee configuration (values from Stripe's pricing for your account and the payment methods you enable, **verify before launch**): one JSON setting, `STRIPE_FEES`, e.g. `{"default":{"percent":0.029,"fixed":30},"eur":{"percent":0.039,"fixed":25}}`. Each entry is `percent` (a fraction) and `fixed` (minor units of that currency). A currency without its own entry uses `default`, with its `fixed` read as USD cents and converted at the quote's implied USD rate. `default` is required.

Limits you should know about:
- **Stripe's real fee varies by card and payment method** (domestic vs international cards, currency conversion to your settlement currency, wallets and local methods like iDEAL or SEPA have different fees). One configured `P` and `F` can't be exact for every payment. Setting them to the **conservative end** guarantees you never net less than `N` and over-collects a little on cheaper cards; setting them to the common case nets exactly `N` on those and slightly less on the dearest. This is a business decision (Decisions section). Under Managed Payments the fee is higher (see "Stripe Managed Payments").
- **Currency conversion at settlement is Stripe's.** For a charge in a currency other than your settlement currency (USD), Stripe converts the funds at its own rate and charges its conversion fee. `N` is "intended amount in the buyer's currency"; the USD you end up holding depends on Stripe's rate. This plan covers Stripe's processing fees in the gross-up; the settlement-conversion fee belongs in `percent` for non-USD currencies (that's what the per-currency entries in `STRIPE_FEES` are for).
- **Surcharging rules** (needs a legal / accountant check before launch): the buyer sees a single card price that is higher than the equivalent Lightning price because it includes processing fees, and the fee is never itemised. Some jurisdictions restrict card surcharges or pricing that differs by payment method (EU/UK rules on consumer cards, some US states, card-network rules). Selling the same product at different prices per payment method is the part to get checked.
- Tax is added on top of `G` by Managed Payments, which withholds it from the payout; it doesn't enter this calculation, and the webhook checks `amount_subtotal`. Whether Stripe's percentage fee is taken on `G` only or on `G` plus tax is to be confirmed with a sandbox charge; if it is the full amount, you net about `P × tax` less than `N`, which you can accept or add to `STRIPE_FEES.default.percent`.

### What the client shows
- The Card panel: a currency select, then the quoted amount with its expiry and **one** button, "Accept and pay". No fee breakdown. If the quote expires while the buyer is deciding, the panel fetches a new one and shows it for acceptance again.
- Name step and seats panel: an indicative price in the chosen display currency (same endpoint, token ignored), with sats available in the switcher (Phase 2). **Fallback:** if Stripe is not configured (`/api/payments/config`), the currency list or quote call fails, or quoting returns 503 (stale rates), these surfaces show the **sats price** instead, with no currency select and no error banner, and Card is hidden on the pay step. Lightning keeps working.
- Analytics: revenue totals are grouped by `price_unit` (`sats`, and every Stripe currency plus Apple's local currencies), and since `price` is the grossed-up charge, analytics shows gross receipts for Stripe rows, not net-of-fees.

---

## Table reference (final state, after both deploys)

### `invoices` — every purchase, pending or fulfilled

| Column | Type | Null | Meaning | Links |
|---|---|---|---|---|
| `id` | serial PK | no | | |
| `product` | varchar | no | `mail` \| `workspace` \| `form` \| `storage` | picks the table `product_id` points at |
| `product_id` | integer | yes | id of the product row | `mails.id`, `workspace_orders.id`, `forms.id`, `storagePlans.id`. `NULL` only on legacy rows the backfill couldn't link (e.g. forms already deleted by the old expiry cron) |
| `pubkey` | varchar | no | buyer's nostr pubkey (mail: mailbox owner; workspace: domain owner; form: form owner; storage: account holder). Legacy form rows hold the form's pubkey (see Current state) | |
| `status` | varchar, CHECK in (`pending`,`fulfilled`) | no (NOT NULL from Deploy B, M13) | payment state (Principle 1) | |
| `provider` | varchar, CHECK in (`lightning`,`stripe`,`apple`,`google`) | no (NOT NULL from Deploy B, M13) | payment method | |
| `payment_hash` | varchar UNIQUE | yes | order key: zap-request pubkey / Checkout Session id / `NULL` for stores | zap receipts, WebSocket, Stripe webhook, order-status endpoint, orchestrator grant |
| `invoice` | text UNIQUE | yes | the payment: BOLT11 / Stripe PaymentIntent id (set at fulfilment) / Apple transactionId / Google orderId. Unique, so one payment can never be recorded twice | refund/dispute events (by PaymentIntent) |
| `price` | integer | yes | amount, in `price_unit`'s minor unit (see "What each payment method writes") | |
| `price_unit` | text | yes | `sats` or lowercase ISO currency | |
| `expires_at` | timestamptz | yes | when a pending invoice can no longer be paid. A pending row past it is an abandoned order | |
| `fulfilled_at` | timestamptz | yes | when `status` became `fulfilled` | |
| `created_at`, `updated_at` | timestamptz | no | | |

Constraints and indexes: `UNIQUE(payment_hash)`, `UNIQUE(invoice)` (Postgres lets several NULLs share a unique column), `UNIQUE(product, product_id)`, `INDEX(status, provider)` for the reconcile crons. None of these are foreign keys.
Removed: `paymentHash` (now `payment_hash`), `lnInvoice` (now `invoice`).

`status` and `provider` (and the `status` column on `mails`, `forms`, `storagePlans`) are added **nullable** in Deploy A, because a NOT NULL column without a default can't be added to a populated table and the new code is still being rolled out. The data migration fills every existing row, the CHECK constraints reject any other value, and the model always writes both. **Deploy B (M13) makes them NOT NULL** with knex's `dropNullable()` once M11 has filled any straggler rows.

### `mails` — one row per mailbox purchase

| Column | Type | Null | Meaning | Links |
|---|---|---|---|---|
| `id` | serial PK | no | | ← `invoices.product_id` (`mail`) |
| `pubkey` | varchar | no | mailbox owner | |
| `status` | varchar, CHECK in (`inactive`,`active`) **(new)** | no (NOT NULL from Deploy B, M13) | `inactive` until paid and the address is created; then `active`. Mailbox lookups read `active` only | |
| `requested_nip05` | varchar **(new)** | yes | the local part asked for (e.g. `alice`; the domain is always `MAIL_DOMAIN`). Set **only while there is no address yet**: on an order awaiting payment, or on a paid order whose name turned out to be taken. Cleared when the address is created | |
| `nip05_id` | integer **(new)** | yes | the address created at fulfilment. Set **only once the address exists** | `nip05.id` (app-level link, **no DB foreign key**) |
| `created_at`, `updated_at` | timestamptz | no | | |

Index: `(pubkey, status)`. Removed in Deploy B: `expirationDate`.
**No duplicated data:** at most one of `requested_nip05` / `nip05_id` is set. Before the address exists the name has to live somewhere, and the `nip05` table is left untouched (an unpaid row there would publish the name in `nostr.json`). Once `nip05_id` is set, the name is read from `nip05`. The model sets one and clears the other in the fulfilment transaction. There is no tier column: there is one mail tier today, so the request's `tierId` is validated and not stored. Legacy rows have neither column set; analytics falls back to today's pairing for them.

### `workspace_orders` (new) — one row per seat purchase

| Column | Type | Null | Meaning | Links |
|---|---|---|---|---|
| `id` | serial PK | | | ← `invoices.product_id` (`workspace`) |
| `domain_id` | integer | no | workspace the seats go to | `domains.id` (app-level link, **no DB foreign key**) |
| `seats` | integer, CHECK > 0 | no | seats bought (any quantity for Lightning/Stripe; the pack's `grants_quantity` for stores) | added to `domains.seats_total` at fulfilment |
| `status` | varchar, CHECK in (`inactive`,`active`) | no | `active` once the seats are added to the domain | |
| `created_at`, `updated_at` | timestamptz | no | | |

Index: `(domain_id, status)`. It's a new table, so `status` can be NOT NULL (no default; the code always writes it). Nothing here repeats data held elsewhere:
- no domain name (it's on `domains`);
- no buyer or amount (both are on the invoice);
- no tier (there's one seat tier today; the zap request keeps sending the constant `tier: base` tag and receipt validation compares against that constant).

If a domain is later deleted, its orders keep a dangling `domain_id`, and the invoice still records buyer and amount.

### `forms` — one row per custom-slug form purchase

| Column | Type | Null | Meaning | Links |
|---|---|---|---|---|
| `id` | serial PK | no | | ← `invoices.product_id` (`form`) |
| `slug` | varchar | no | the custom slug bought. **Unique among active rows only**, so inactive orders don't hold a slug and an expired slug can be bought again | |
| `pubkey` | varchar | no | the form's own nostr pubkey | |
| `identifier` | varchar | no | the form's identifier (d-tag) | |
| `relays` | jsonb | no | relays the form lives on | |
| `owner` | varchar | no | owner's pubkey (= `invoices.pubkey` on new rows) | |
| `viewKey` | varchar | yes | view key for encrypted forms | |
| `expirationDate` | timestamptz | yes | **now set at fulfilment** (paid + 3 months; today it's set when ordering). `NULL` while inactive and never activated | |
| `status` | varchar, CHECK in (`inactive`,`active`) **(new)** | no (NOT NULL from Deploy B, M13) | `inactive` until paid, `active` while live, `inactive` again after `expirationDate`. Slug lookups read `active` only | |
| `created_at`, `updated_at` | timestamptz | no | | |

Indexes: partial `UNIQUE(slug) WHERE status = 'active'` (**replaces** the current `UNIQUE(slug)`; see M7), `(owner, status)`.
Expiry change: `cleanupExpiredForms` flips `status` to `inactive` instead of deleting the row (decided).

### `storagePlans` — one row per storage plan purchase

| Column | Type | Null | Meaning | Links |
|---|---|---|---|---|
| `id` | serial PK | no | | ← `invoices.product_id` (`storage`) |
| `pubkey` | varchar | no | storage account holder (= buyer) | orchestrator user |
| `plan` | varchar | no | catalog plan id | `utils/storagePlans.ts` |
| `status` | varchar, CHECK in (`inactive`,`active`) **(new)** | no (NOT NULL from Deploy B, M13) | `active` once the orchestrator entitlement is assigned. "Current plan" and history read `active` only | |
| `created_at`, `updated_at` | timestamptz | no | | |

Index: `(pubkey, status)`. Removed in Deploy B: `payment_hash`, which duplicates `invoices.payment_hash`. The orchestrator grant key now comes from the invoice.
The plan's expiry and allowance live in the orchestrator, as today. This row records only what was bought.

### `store_products` (new) — App Store / Play SKU catalog

| Column | Type | Null | Meaning |
|---|---|---|---|
| `id` | serial PK | | |
| `platform` | varchar, CHECK in (`apple`,`google`) | no | |
| `app_identifier` | varchar | no | Apple bundle id / Google package name the SKU belongs to (verification checks against it) |
| `store_product_id` | varchar | no | SKU as created in the console |
| `product_type` | varchar, CHECK in (`non_consumable`,`consumable`) | no | mail = `non_consumable` (restorable); seat packs = `consumable` (bought repeatedly; consumed after granting) |
| `grants_product` | varchar | no | product the purchase creates (`mail` \| `workspace`) |
| `grants_tier` | varchar | no | tier it grants (`base`) |
| `grants_quantity` | integer, CHECK > 0 | no | `1` for a mailbox, the pack size for seats |
| `active` | boolean | no | inactive SKUs are refused by verify and hidden from tiers |
| `created_at`, `updated_at` | timestamptz | no | |

`UNIQUE(platform, store_product_id)`. Seeded per environment by `scripts/seedStoreProducts.ts`, not by a migration.

| Platform | `store_product_id` | type | grants |
|---|---|---|---|
| google | `mailbox_base` | non_consumable | mail × 1 |
| apple | `com.formstr.mail.mailbox.base` | non_consumable | mail × 1 |
| google | `workspace_seats_1` / `_10` / `_50` | consumable | workspace × 1 / 10 / 50 |
| apple | `com.formstr.mail.workspace.seats1` / `seats10` / `seats50` | consumable | workspace × 1 / 10 / 50 |

Pack sizes (1 / 10 / 50) are decided. A 1-seat pack is the same consumable mechanism as the others, so buying seats one at a time in a store build works; the 10 and 50 packs exist for convenience, not because the mechanism needs them.

### Related tables this plan reads or writes but doesn't restructure

| Table | Role here |
|---|---|
| `nip05` | mail fulfilment inserts the address (`UNIQUE(nip05, domain)` stops two people getting one address); `mails.nip05_id` refers to it (no DB foreign key); the table itself is unchanged |
| `domains` | seat fulfilment increments `seats_total` (`services/seats.ts addSeats`, inside the fulfilment transaction); `workspace_orders.domain_id` refers to it (no DB foreign key) |

### Tables removed

| Table | Replaced by |
|---|---|
| `pendingMails` | `mails` (`inactive`) + `invoices` (`pending`) |
| `pendingDomainOrders` | `workspace_orders` (`inactive`) + `invoices` (`pending`) |
| `pendingForms` | `forms` (`inactive`) + `invoices` (`pending`) |
| `pendingStoragePlan` | `storagePlans` (`inactive`) + `invoices` (`pending`) |

---

## Migrations

### Rules

- No `renameColumn`, no `.alter()` on existing columns, no `knex.raw`. **Two exceptions:** `dropNullable()` / `setNullable()` (schema builder, no raw SQL) in **M1a** (relax the old `paymentHash`) and **M13** (make the new `status` / `provider` columns NOT NULL). Schema changes use the knex schema builder (`createTable`, `table()` to add/drop columns and indexes, `checkIn` / `checkPositive`, a partial unique via the `predicate` option, built from the query builder). Data changes use the query builder; where a value comes from another column of the same row, `knex.ref('col')` is used, which is an identifier reference, not raw SQL.
- Replacing a column goes add new → copy data → (code switches over) → drop old. Old columns and tables are dropped only in the **contract** deploy.
- New columns get no defaults. Existing rows are filled by an explicit data migration.
- No database foreign keys. Links between tables (`product_id`, `nip05_id`, `domain_id`) are integers resolved by the models.
- Every migration is its own commit (`AGENTS.md`), with one table per schema migration. Schema and data migrations are separate files.
- Migrations don't import app code (`src/…`). Each one is a self-contained snapshot.
- The entrypoint runs `knex.migrate.latest()` on every deploy, so **the contract migrations live on a separate branch/PR** that gets merged only after the expand deploy is verified in production.

### Deploy A — expand (feature branch off `main`)

| # | File | Kind | What it does | `down()` |
|---|---|---|---|---|
| M1 | `20261020100000_invoices_unified_columns.ts` | schema | `invoices` add `payment_hash` varchar UNIQUE, `invoice` text UNIQUE, `provider` varchar `checkIn([lightning,stripe,apple,google])`, `status` varchar `checkIn([pending,fulfilled])`, `product_id` integer, `expires_at` timestamptz, `fulfilled_at` timestamptz (all nullable); `UNIQUE(product, product_id)`; `INDEX(status, provider)` | drop them |
| M1a | `20261020100050_invoices_payment_hash_nullable.ts` | schema | `invoices."paymentHash"` → nullable via `dropNullable()` (the UNIQUE constraint stays; Postgres lets several NULLs share it). Needed because **Stripe and store rows have no legacy hash**: a Stripe invoice is inserted before its Checkout Session exists, and a store purchase has no order key at all, while the old column is NOT NULL until Deploy B. With this, **Stripe and store payments can go live on Deploy A**. Old code keeps working (it always supplies a hash) | `setNullable()` on `paymentHash`. Fails with a clear message if any row has a NULL hash (a Stripe or store invoice exists), because those rows can't be represented in the old schema: rolling back Deploy A after Stripe/IAP are live is lossy by nature |
| M2 | `20261020100100_invoices_backfill.ts` | data | `invoices.whereNull('payment_hash').update({ payment_hash: ref('paymentHash'), invoice: ref('lnInvoice'), provider: 'lightning', status: 'fulfilled', fulfilled_at: ref('created_at') })`. Every existing row is a paid Lightning purchase. Before updating, it checks that no BOLT11 appears twice in `lnInvoice` (which would break `UNIQUE(invoice)`); if one does, it aborts and lists the ids | set those columns back to `NULL` (the old columns still hold the data) |
| M3 | `20261020100200_mails_order_columns.ts` | schema | `mails` add `status` varchar `checkIn([inactive,active])`, `requested_nip05` varchar, `nip05_id` integer (no FK) (all nullable); `INDEX(pubkey, status)` | drop them |
| M4 | `20261020100300_forms_status.ts` | schema | `forms` add `status` varchar `checkIn([inactive,active])` (nullable); `INDEX(owner, status)` | drop them |
| M5 | `20261020100400_storage_plans_status.ts` | schema | `storagePlans` add `status` varchar `checkIn([inactive,active])` (nullable); `INDEX(pubkey, status)` | drop them |
| M6 | `20261020100500_product_status_backfill.ts` | data | `mails` → `active`. `forms` → `active` where `expirationDate` is null or in the future, else `inactive`. `storagePlans` → `active`. Every existing product row was paid for | set `status` back to `NULL` |
| M7 | `20261020100600_forms_active_slug_unique.ts` | schema | `forms` add partial unique index `forms_slug_active_unique` on `slug` with `predicate: where status = 'active'`, then drop the old `UNIQUE(slug)` constraint. Done in Deploy A because the new code creates inactive form orders straight away, and two orders for the same slug mustn't collide | add `UNIQUE(slug)` back, drop the partial index (fails if inactive duplicates exist; documented) |
| M8 | `20261020100700_workspace_orders.ts` | schema | create `workspace_orders` (table reference above) | drop table |
| M9 | `20261020100800_transfer_pending_orders.ts` | data | see "M9 in detail" below | delete the rows M9 inserted (tracked by `payment_hash`); clear `product_id` on rows it linked |
| M10 | `20261020100900_store_products.ts` | schema | create `store_products` (table reference above) | drop table |

**M9 in detail.** It runs in the migration's transaction, iterates in JS, is idempotent (a `paymentHash` that already has an `invoices` row is linked or skipped, never duplicated), and logs counts per step.

Every **pending** invoice M9 inserts gets `provider: 'lightning'`, `status: 'pending'`, `payment_hash` and `invoice` from the pending row, the same values in the old `paymentHash` / `lnInvoice` columns (`paymentHash` is NOT NULL until Deploy B), `expires_at: created_at + 24 h` (long-dead legacy orders count as abandoned straight away), and the pending row's `created_at`.

1. **`pendingMails`** rows with no invoice for their hash: insert `mails { pubkey, status: 'inactive', requested_nip05: <local part> }` plus a pending invoice (`product: 'mail'`, `pubkey`, `price: NULL`; fulfilment fills it from the paid BOLT11).
2. **`pendingDomainOrders`** rows: look up `domains.id` by name; if the domain no longer exists, skip the row and log it (an existing ledger row for it stays unlinked). Otherwise insert `workspace_orders { domain_id, seats }`, then:
   - an invoice for the hash already exists → `status: 'active'`, and link the invoice's `product_id`;
   - else `granted_at` is set → `status: 'active'`, plus a **fulfilled** invoice (`price: amount_sats`, `price_unit: 'sats'`, `fulfilled_at: granted_at`);
   - else → `status: 'inactive'`, plus a pending invoice (`price: amount_sats`, `price_unit: 'sats'`).
3. **`pendingForms`** rows with no invoice for their hash: insert `forms { slug, pubkey, identifier, relays, owner, viewKey, expirationDate: NULL, status: 'inactive', created_at: <from createdAt epoch> }` plus a pending invoice (`product: 'form'`, `pubkey: owner`, `price: NULL`). The partial index lets an inactive row share a slug with an active form.
4. **`pendingStoragePlan`** rows with no invoice for their hash: insert `storagePlans { pubkey, plan, payment_hash, status: 'inactive' }` (`payment_hash` because that column is still NOT NULL) plus a pending invoice (`product: 'storage'`, `price: amount_sats`, `price_unit: 'sats'`). A pending row whose `storagePlans` entry already exists with the same `payment_hash` was granted but not cleaned up. It's skipped.
5. **Link legacy fulfilled ledger rows** (`product_id IS NULL`):
   - `storage`: exact. `storagePlans.payment_hash = invoices.payment_hash`.
   - `workspace`: exact. Handled in step 2.
   - `mail`: heuristic. Take the latest unlinked `active` `mails` row with the same `pubkey`, created at or before the invoice and within 10 minutes of it (provisioning writes the mailbox, then the ledger row, seconds apart).
   - `form`: heuristic. Take the unlinked `forms` row whose `pubkey` equals the invoice's `pubkey` (legacy form invoices carry the form's pubkey), created within 10 minutes of the invoice.

   Unmatched rows stay `NULL` and their ids are logged. That's expected for forms the old cron already deleted, and for mailboxes created by `createMailboxHandler` without a payment.

### Deploy B — contract (separate PR, merged after Deploy A is verified in prod)

| # | File | Kind | What it does | `down()` |
|---|---|---|---|---|
| M11 | `20261103100000_transfer_pending_orders_final.ts` | data | repeats M9's body, to catch rows the old code wrote into the four pending tables in the seconds between M9 running and the new code starting. Also repeats M2's copy for any row with `payment_hash IS NULL AND "paymentHash" IS NOT NULL`, and M6's status fill for any `mails` / `forms` / `storagePlans` row whose `status` is still NULL (written by the old code in the same window) | no-op |
| M12 | `20261103100100_drop_legacy_columns.ts` | schema | `invoices` drop `paymentHash`, `lnInvoice`; `mails` drop `expirationDate`; `storagePlans` drop `payment_hash`; drop tables `pendingMails`, `pendingDomainOrders`, `pendingForms`, `pendingStoragePlan`. **Destructive for `mails.expirationDate`**: the historical dates are lost. Take `pg_dump -t mails -t storagePlans` before deploying | recreate `invoices.paymentHash` (nullable: store rows have none) and `lnInvoice`, copy back from `payment_hash` / `invoice`; recreate `mails.expirationDate` (nullable, empty); recreate `storagePlans.payment_hash` (nullable) and copy back from the linked invoice; recreate the four tables with their original columns, empty |
| M13 | `20261103100200_status_provider_not_null.ts` | schema | `invoices.status`, `invoices.provider`, `mails.status`, `forms.status`, `storagePlans.status` → NOT NULL via `dropNullable()`. First checks that no NULL remains in any of them; if one does, it aborts and lists table and ids (M11 should have filled them) | `setNullable()` on the same five columns |

Between A and B the new code **dual-writes only Lightning rows**: `payment_hash`/`paymentHash` and `invoice`/`lnInvoice` get the same values on insert, which is all the old columns ever held. **Stripe and store rows leave the legacy columns NULL** (`paymentHash` is nullable since M1a), including when Stripe's `payment_hash` is set later by an UPDATE, so no update-time dual-write is needed. The new code also writes `storagePlans.payment_hash` on new storage orders, and stops writing `mails.expirationDate`. Nothing reads the old columns, and nothing writes the old pending tables. Stripe and IAP therefore **do not depend on Deploy B**.

### Migration verification

**To be built with the migrations (not now).** A single-purpose, **local-only tool for this migration set**: never checked in (planned location `formstr-backend/.local/migration-verify/`, excluded through `.git/info/exclude`, not `.gitignore`, not a commit), thrown away afterwards. It runs against **staging or prod data** and is a two-step process, once per deploy:

**Step 1: clone the data and save it** (`snapshot --source <db-url> --name pre-A`)
- Connects **read-only** (a `READ ONLY` transaction; the tool has no write path to the source) and saves a point-in-time copy to `.local/migration-verify/snapshots/<name>/`: every row of `invoices`, `mails`, `forms`, `storagePlans`, `nip05`, `domains`, `domain_members`, `domain_member_addresses`, `users` and the four pending tables (one JSON file per table), the schema (columns, types, nullability, defaults, indexes, constraints), the `knex_migrations` list, and the capture time.
- Run it **before** the deploy that carries the migrations (`pre-A` before Deploy A, `pre-B` before Deploy B). The snapshot holds pubkeys and invoices: files are mode 600 and never leave the machine.

**Step 2: check that the migrated data is correct and expected** (`check --target <db-url> --snapshot pre-A`)
- Run **after** the migrations have run on the target (staging after its deploy, prod after its deploy, or any database you restored the snapshot into and migrated). Also read-only. It compares the migrated database with the saved snapshot using an oracle written independently of the migrations, so a bug in a migration can't hide in a shared helper. It prints a report with PASS / FAIL / NOTE per check, lists offending row ids, and exits non-zero on any hard failure.
- Because prod keeps taking orders after the deploy, rows created by the new code (ids and keys not in the snapshot, written after the migration time) are reported as NOTES, not failures. Only rows from the snapshot and the rows the migration is specified to create are held to the spec. Heuristic links (mail and form ledger rows) are reported as a separate list for human review, not as failures.

What `check` asserts (Deploy A, against `pre-A`):
- every snapshot row of `invoices`, `mails`, `forms`, `storagePlans` is still present with every original value; the untouched tables and the four pending tables are identical;
- invoices become `lightning` / `fulfilled` with `payment_hash` / `invoice` equal to the old columns, `fulfilled_at` equal to `created_at`;
- product rows get the right `status` (forms by `expirationDate` relative to the migration time recorded in `knex_migrations`);
- every pending-table row with no invoice for its hash ends up as exactly the invoice + product row M9 specifies (fields, status, `expires_at`, price and unit, form `created_at` from the epoch); rows with an existing invoice, a missing domain, or an existing `storagePlans` entry produce nothing new and are listed;
- no extra rows beyond those the spec produces, and the counts per table match;
- deterministic ledger links (storage, workspace) are exact; mail and form links follow the 10-minute rules, with mismatches and unlinked rows listed;
- global invariants: no NULL `status` / `provider`; `UNIQUE(product, product_id)`; each `product_id` resolves to a row of the right table; each inactive product row has exactly one pending invoice; no pending invoice points at an active row; `payment_hash` / `paymentHash` and `invoice` / `lnInvoice` agree on every row;
- schema: the new columns, CHECK constraints, partial unique index `forms_slug_active_unique` (and no old `UNIQUE(slug)`) and indexes exist as specified.

Deploy B, against `pre-B` (taken after A is verified in prod):
- the legacy columns and the four pending tables are gone; every other column of every surviving row is unchanged;
- anything the old code wrote in the A→B window (straggler pending rows, invoices without `status`, product rows without `status`) was transferred or filled, so nothing was lost;
- information from the dropped columns is not lost: each `storagePlans.payment_hash` in the snapshot still exists as an invoice `payment_hash` (storage rows with no invoice are listed), and the count of non-NULL `mails.expirationDate` values discarded is reported;
- `invoices.status` / `provider` and the product `status` columns are NOT NULL and hold no NULLs.

**Optional dry run** (`restore --snapshot pre-A --into <scratch-db-url>`): loads a snapshot into a scratch database so you can run the migrations (including `down` and `up` again) and `check` before touching staging or prod. It refuses any URL that isn't an empty database. The reversibility checks live here, because they need writes: after `down`, every baseline table equals the snapshot row for row and the schema matches the pre-migration schema (the one documented exception is `storagePlans.payment_hash`, which M12's `down` recreates as nullable), and `up` again passes `check`. Synthetic edge-case seed data (a taken slug, a missing domain, duplicate bolt11, granted-but-uncleaned storage rows, two same-pubkey mailboxes minutes apart, etc.) is also available for this mode so every branch of M9 is exercised even if production data doesn't hit it.

Before each commit: `npx tsc --noEmit` and `npx jest`.

---

## Purchase lifecycles (what is written, step by step)

**Lightning (all four products)**
1. Invoice endpoint (`/api/generate-invoice/mail|form|storage`, `/api/workspace/generate-invoice`): `validate<Product>Order` → build the zap request → fetch the BOLT11 → one transaction: insert the product row (`inactive`) plus `invoices { status: pending, provider: lightning, payment_hash, invoice: bolt11, price, price_unit: 'sats', expires_at: <bolt11 expiry> }` → `listenForPayment(payment_hash)`. Response shapes are unchanged.
2. Zap receipt (live listener or reconcile cron) → `validatePendingReceipt` against the invoice + product row → `fulfilInvoice({ paymentHash, paidInvoice: bolt11 })`.
3. `fulfilInvoice` transaction: the conditional flip to `fulfilled` (sets `fulfilled_at`, and `price` if NULL), then the product handler:
   - **mail**: insert `nip05` from `requested_nip05` → `mails` `active`, `nip05_id` set, `requested_nip05` cleared;
   - **workspace**: `addSeats(domain_id, seats)` → `workspace_orders` `active`;
   - **form**: `forms` `active`, `expirationDate = now + 3 months` (the partial unique index rejects a slug that's already active);
   - **storage**: re-check `derivePurchaseMode` → `assignEntitlement(pubkey, { …, paymentHash: invoice.payment_hash })` → `storagePlans` `active`. The orchestrator call happens inside the transaction. If it fails, everything rolls back and the invoice stays `pending` for the reconciler. If it succeeded but the commit fails, the retry is still safe, because the grant is keyed by `payment_hash` on the orchestrator.

   After commit: welcome mail / storage mail / WebSocket `{status:"paid"}`.

**Stripe (mail / workspace)**
0. `POST /api/quotes { currency, product, tierId | seats }` → `{ currency, exponent, amountMinor, expiresAt, quoteToken }` (see Currencies and fiat pricing). The client shows it; the buyer accepts.
1. `POST /api/stripe/checkout` (carries the `quoteToken`):
   - validate the order and the quote token (signature, expiry, matches the order, token sats == current configured sats price; otherwise 409 with a reason and the client re-quotes);
   - one transaction: product row (`inactive`) + `invoices { status: pending, provider: stripe, payment_hash: NULL, price: <quoted amountMinor>, price_unit: <quoted currency>, expires_at: now+30m }`;
   - `checkout.sessions.create({ …, line_items: [price_data { currency, unit_amount: <price>, tax_behavior: 'exclusive', product_data { name, tax_code } }], managed_payments: { enabled: true }, client_reference_id: <invoice id> }, { idempotencyKey: 'invoice-<id>' })`;
   - set `invoices.payment_hash = session.id`.

   If session creation fails, set `expires_at = now()` (the order is abandoned at once; nothing is deleted) and return 502. If the `payment_hash` write fails after the session exists, the webhook still finds the row through `client_reference_id` and back-fills `payment_hash`.
2. Webhook `checkout.session.completed` (paid) → load the invoice by `payment_hash = session.id` (fallback: `id = client_reference_id`, then check `payment_hash` is NULL or equal) → check `amount_subtotal === price`, `currency === price_unit`, `mode === 'payment'` → `fulfilInvoice({ paymentHash: session.id, paidInvoice: session.payment_intent })`, which writes the PaymentIntent id into `invoice`.
3. The client polls `GET /api/orders/:sessionId/status`.

**Apple / Google — mailbox (non-consumable)**
1. Purchase happens on-device. `POST /api/store/verify { product: 'mail', nip05, tierId, … }` → resolve the SKU → `validateMailOrder` → verify with the store → one transaction: `mails` (`inactive`) + `invoices { status: pending, provider, payment_hash: NULL, invoice: <transactionId / orderId>, price/price_unit: <Apple price/currency; Google NULL> }`, then `fulfilInvoice` in the same transaction. Google: acknowledge after commit.
2. A duplicate verify hits `UNIQUE(invoice)` → `already_provisioned`. "Restore purchases" re-verifies past transactions.

**Apple / Google — workspace seat pack (consumable)**
1. The domain owner picks a pack. The purchase happens on-device, and the client **does not finish/consume the transaction yet**.
2. `POST /api/store/verify { product: 'workspace', domain, … }` → resolve the SKU (`grants_quantity` = seats; the request never carries a seat count) → `validateWorkspaceOrder` → verify with the store (Apple: type `Consumable`; Google: `purchaseState == 0`, `consumptionState == 0`) → one transaction: `workspace_orders { seats: grants_quantity, status: 'inactive' }` + invoice, then `fulfilInvoice`.
3. Google: **consume** server-side after commit (`purchases.products.consume`; this also acknowledges, and frees the SKU to be bought again). Apple: the client calls `finish()` once verify returns.
4. Recovery: an unconsumed Google purchase or an unfinished Apple transaction stays in the store's queue, and the client re-sends it to verify on every app start. `UNIQUE(invoice)` makes that safe: it returns `already_provisioned`, and the client then consumes/finishes. Consumables can't be restored, and don't need to be, because the seats live on the domain on the server.

**Paid but not provisionable** (Principle 6). Results are `needs_attention` with a reason. The client gets the reason, and the admins get an alert mail after commit (1l). Cases:
- **Mail**: address taken by another pubkey. The order-time availability check (1c) means this only happens when two orders for the same name are placed at the same moment. An address already owned by the **same** pubkey (a repeat delivery) counts as provisioned.
- **Form**: slug went active for someone else between order and payment.
- **Workspace**: domain deleted or suspended since the order.
- **Storage**: `derivePurchaseMode` no longer allows the plan (e.g. a higher plan was bought in between). Today this leaves the pending row in place and the reconciler retries it forever.

**Abandoned orders**: never deleted. A `pending` invoice past `expires_at` with an `inactive` product row is abandoned. The order-status endpoint reports it as `expired`, analytics lists it as abandoned, and reconcilers skip it after their grace period (1i). A late payment on one is still honoured.

---

## Phase 0 — Consoles & accounts (no code)

1. **Stripe** (account onboarded and activated)
   - US account, settling in USD. **Enable Managed Payments** in Dashboard → Settings → Managed Payments and accept its terms; use API version `2025-03-31.basil` or later. Check eligibility and the **fee** on Stripe's pricing page before launch (the fee feeds `STRIPE_FEES`). Keep the Dashboard support e-mail correct (Stripe escalates cases there; an unanswered case is refunded after 48 hours). In Tax settings keep "tax included in prices" **off**. Choose the product tax code(s) with the accountant.
   - Create a **restricted API key** (Checkout Sessions: write; PaymentIntents/Charges: read) for test mode and for live mode, not the root secret key.
   - Register the webhook `https://<api>/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, plus `charge.refunded` and `charge.dispute.created` (logged). Save the signing secret per environment.
   - Dashboard: enable card and wallets, and only the local payment methods you want for the currencies in `FIAT_CURRENCIES` (a method is offered only when it supports the session's currency). Checkout branding, statement descriptor, Radar defaults. Decide on Stripe Tax. Look up Stripe's fee for each payment method and currency you enable: they become `STRIPE_FEES`.
   - Local dev: `stripe listen --forward-to localhost:5000/api/stripe/webhook`.
   - There are no fiat prices in config and no Stripe Price objects. The sats prices are the only prices; Checkout uses inline `price_data` with the quoted amount.
2. **Google Play Console**
   - Confirm the app `com.formstr.mail` exists (create the listing if not).
   - One-time products: `mailbox_base` (granted once, never consumed) and `workspace_seats_1` / `_10` / `_50` (consumed after each grant). Set the base price; Play localizes per country.
   - Service account with the *Financial data* role, linked under Monetization setup → API access. Download the JSON key.
   - License testers on the internal testing track.
3. **App Store Connect**
   - App record for `com.formstr.mail` (bundle id registered in the developer account).
   - Sign the **Paid Applications Agreement** and complete banking/tax. IAP can't be tested without it.
   - IAPs: **non-consumable** `com.formstr.mail.mailbox.base`; **consumable** `com.formstr.mail.workspace.seats1` / `seats10` / `seats50`. Each needs pricing, localized metadata and a review screenshot.
   - Sandbox tester account(s).
   - App Store Server API key (.p8): Key ID + Issuer ID.
4. Pricing: Lightning in sats; Stripe = the sats price converted to the buyer's chosen currency plus Stripe's fees; store prices set in the consoles. No forced parity between methods.

---

## Phase 1 — Backend (formstr-backend)

Policy (`AGENTS.md`): feature branch off `main`, each migration in its own commit, `npx tsc --noEmit` + `npx jest` green, explicit approval before any deploy runs the migrations, and state the target remote before pushing.

### 1a. Migrations
As in **Migrations** above: M1–M10 (including M1a) on the feature branch, M11–M13 on a follow-up branch.

### 1b. Shared DB handle and models
- `src/db.ts` (new): one shared knex instance. The models taking part in orders and fulfilment (`invoices`, `mails`, `workspaceOrders`, `form`, `storagePlan`, `nip05`, `services/seats`) import it, and their write functions take an optional `trx`, so a purchase can commit or roll back as one unit.
- `models/invoices.ts` (rewritten): the `InvoiceRecord` columns from the table reference. Functions:
  - `createPendingInvoice`;
  - `claimInvoice(trx, paymentHash | id, evidence)`: the conditional flip, returns the row or null;
  - `getInvoiceByPaymentHash`, `getInvoiceByPaymentRef`, `getInvoiceByBolt11`;
  - `getInvoicesForProducts(product, ids)` (storage history prices);
  - `getReconcilableInvoices({ provider, products, graceMs })`: pending and not past `expires_at + grace`;
  - `expireInvoice(id)`: sets `expires_at = now()`;
  - `getInvoicesByFilter`: gains a `status` filter.

  During Deploy A every insert also writes `paymentHash` / `lnInvoice`. That's one clearly marked block, deleted with Deploy B.
- `models/mails.ts`: add `status`, `requested_nip05`, `nip05_id`; drop `expirationDate` from `MailRecord`. `getMailByPubkey` reads `active` only. Add `createInactiveMail(trx, { pubkey, requestedNip05 })`, `activateMail(trx, id, nip05Id)` (sets `nip05_id`, clears `requested_nip05`).
- `models/workspaceOrders.ts` (new): `createWorkspaceOrder(trx, …)`, `activateWorkspaceOrder(trx, id)`, `getWorkspaceOrder(id)`.
- `models/form.ts`: `StoredForm` gains `id` and `status`. `getFormBySlug` / `getFormsByOwner` read `active` only. Add `createInactiveForm(trx, …)`, `activateForm(trx, id, expirationDate)`, `expireForms(now)` (flips past-expiry active rows to `inactive`). `createForm` (admin path) inserts `active`. `models/types.ts` loses `PendingForm`.
- `models/storagePlan.ts`: add `status`; drop `payment_hash` from the record type (Deploy A still writes it on insert, marked temporary). `getLatestStoragePlanByPubkey` / `getStoragePlansByPubkey` read `active` only. Add `createInactiveStoragePlan(trx, …)`, `activateStoragePlan(trx, id)`. Delete `getStoragePlanByPaymentHash` and `deleteStoragePlanByPaymentHash` (the claim is now the invoice flip, and rollback is the transaction).
- `models/storeProducts.ts` (new): `getActiveStoreProduct(platform, storeProductId)`, `getStoreProductsFor(product, tier)`.
- Delete `models/pendingMail.ts`, `models/pendingDomainOrder.ts`, `models/pendingForm.ts`, `models/pendingStoragePlan.ts`, `models/utils.ts` (`createFormFromZap`) and their tests.

### 1c. Order validation and creation
- `services/orderValidation.ts` (new). One validator per product, lifted out of the current handlers and shared by every payment method:
  - `validateMailOrder({ pubkey, nip05, tierId })`: reserved name; tier exists and is available; nip05 normalized to its local part; **address not already in `nip05`** (new).
  - `validateWorkspaceOrder({ pubkey, domain, seats })`: domain exists, the caller owns it, it isn't suspended; seats within `MIN_SEATS`–`MAX_SEATS` and `seats_total + seats ≤ MAX_SEATS`.
  - `validateFormOrder({ owner, slug, formPubkey, formId, relays })`: `isValidSlug`, required fields, relays a non-empty array, **slug not held by an active form** (new).
  - `validateStorageOrder({ pubkey, planId, termsAccepted })`: terms accepted, plan exists and isn't `comingSoon`, `derivePurchaseMode` allows it, signups open when there's no current plan.
- `services/orders.ts` (new): `createOrder(trx, { product, details, invoice })` inserts the `inactive` product row and the pending invoice, and returns both.

### 1d. Fulfilment — `services/invoiceFulfilment.ts` (new)
Replaces `services/mailProvisioning.ts`, `services/workspaceProvisioning.ts`, `services/storageProvisioning.ts`, and `createFormFromZap`.
- `fulfilInvoice({ paymentHash | invoiceId, paidInvoice?, price? }, trx?)`: claim, then call the product handler inside the transaction, then commit, then run side effects. Results: `fulfilled` | `already_fulfilled` | `not_found` | `needs_attention` (Principle 6). On `needs_attention`, the side effects include `sendAdminAlert('paid_not_provisioned', …)` (1l). Only the call that won the claim reaches this point, so a replayed receipt, webhook or verify never sends a second alert.
- Product handlers, in a registry keyed by `product`: `fulfilMail`, `fulfilWorkspace`, `fulfilForm`, `fulfilStorage` (see the lifecycle). Each returns `ok` or `needs_attention` with a reason, and throws on retryable failures (database, orchestrator unreachable) so the transaction rolls back.
- `handlers/zapReceiptHandler.ts`: every product goes through `fulfilInvoice`, and every result, including `needs_attention`, sends a WebSocket message. The trailing ledger insert and the per-product helper functions (`createForm`, `createMail`, `createWorkspaceOrder`, `createStorage`) are deleted.
- `services/receiptValidation.ts`: `getExpectedOrder` reads the pending invoice (`invoice` = the BOLT11 to match) plus its product row for every product:
  - mail: `{ pubkey, nip05: mails.requested_nip05 }`, compared on the local part so zap requests from before the migration that carried `alice@domain` still match;
  - form: `{ formPubkey, slug, formId }`;
  - workspace: `{ pubkey, domain: <name from domains via domain_id>, seats, tier: 'base' }` (`tier` is a constant while there's one tier);
  - storage: `{ pubkey, plan }`.
- `services/storageSubscription.ts`: history prices come from `getInvoicesForProducts('storage', ids)`, and `paymentHash` in the history response comes from the invoice.

### 1e. Invoice handlers and permanent mailboxes
- `paymentController`: `generateMailsInvoiceHandler`, `generateWorkspaceInvoiceHandler`, `generateFormsInvoiceHandler`, `generateStorageInvoiceHandler` all become validate → zap request → BOLT11 → `createOrder`. `price` is set when ordering (tier price / `priced.totalSats` / forms price / `plan.priceSats`), and `expires_at` comes from the BOLT11 (`utils/bolt11.ts` gains `parseBolt11Expiry`).
  - Mail stops setting an expiry.
  - Forms stop setting `expirationDate` when ordering (it's set at fulfilment).
  - The form invoice's `pubkey` is the owner (NIP-98), not the form pubkey.
- `mailController.createMailboxHandler`: creates `mails { status: 'active' }` with no expiry and no invoice. `getMailboxHandler`'s response loses `expirationDate` (no nail client reads it).
- `formController.createFormHandler` (admin): creates an `active` form, no invoice, unchanged otherwise.
- `getExpirationFromNow()` stays for forms (used at fulfilment).

### 1f. Stripe — `services/stripePayments.ts`, `controllers/stripeController.ts`, `routes/stripeRoutes.ts` (new)
Deps: `stripe` (official Node SDK, pinned `apiVersion`; use that version's name for the embedded UI mode). Env: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`; pricing: `FIAT_CURRENCIES`, `STRIPE_FEES`, `QUOTE_SECRET`, `QUOTE_TTL_SECONDS`, `FX_MAX_AGE_SECONDS`, `FX_CACHE_SECONDS`, `FX_MAX_DEVIATION`. Stripe is disabled while `STRIPE_SECRET_KEY` is unset. Once it's set, a missing `QUOTE_SECRET`, or a missing or invalid `STRIPE_FEES` (it needs a `default`), is a startup error.
- **`GET /api/payments/currencies`** → `{ currencies: [{ code, name, exponent }], default }` (see Currencies and fiat pricing).
- **`POST /api/quotes`** (unauthenticated, rate-limited per IP; computed from the rate cache) body `{ currency, product: 'mail'|'workspace', tierId, seats? }` → `{ currency, exponent, amountMinor, expiresAt, quoteToken, minimumApplied? }`. 400 for an unknown currency or order, 503 when the rate is stale or the sources disagree.
- **`POST /api/stripe/checkout`** (NIP-98; `req.nostrPubkey` must equal the body pubkey or the domain owner). Body `{ product: 'mail'|'workspace', tierId, nip05 | domain+seats, quoteToken, uiMode: 'embedded'|'hosted' }`. Follows the Stripe lifecycle above. `line_items` use `price_data { currency, unit_amount }` taken from the verified quote, with `quantity: 1` (the quote already covers the seat total). The session sets `managed_payments: { enabled: true }`, `price_data.tax_behavior: 'exclusive'` and `product_data.tax_code`; it does **not** send `adaptive_pricing`, `automatic_tax`, `payment_method_types`, `invoice_creation` or `receipt_email` (not allowed with Managed Payments). `payment_intent_data.capture_method` stays automatic. `expires_at` is now+30m. `return_url` (embedded) or `success_url` + `cancel_url` (hosted). Response `{ sessionId, clientSecret | url, amount, currency }`. A bad, expired or mismatched quote → 409 `{ reason: 'quote_expired' | 'quote_mismatch' | 'price_changed' }`.
- **`POST /api/stripe/webhook`**: mounted with `express.raw({ type: 'application/json' })` **before** `app.use(express.json())` in `src/index.ts`, verified with `stripe.webhooks.constructEvent`, no NIP-98.
  - `checkout.session.completed` with `payment_status === 'paid'`, or `async_payment_succeeded`: check `amount_subtotal` / `currency` against the invoice's `price` / `price_unit` (`amount_subtotal`, not `amount_total`, so the check is correct whichever way the Stripe Tax decision goes: tax never changes the subtotal), then fulfil.
  - A fulfilment error returns **HTTP 500** so Stripe retries (exponential backoff for ~3 days). `needs_attention` returns 200. Unknown events return 200. Duplicate deliveries are no-ops (`already_fulfilled`).
  - `checkout.session.expired` / `async_payment_failed`: `expireInvoice` if still pending. The rows stay.
  - `charge.refunded` / `charge.dispute.created`: the invoice is found by `invoice = <payment_intent>`. Logged and sent to the admins as `stripe_refund` / `stripe_dispute` alerts (1l). Stripe can issue refunds by itself under Managed Payments (within 60 days), so these alerts are the only signal that a customer was refunded. No automatic revocation yet (Decisions).
- **`GET /api/orders/:sessionId/status`** → `{ status: 'pending'|'paid'|'expired' }`, unauthenticated. The session id is long and random (the client already holds it inside the Checkout client secret), and the response carries nothing else. `fulfilled` → paid. `pending` and `expires_at` in the future → pending. Anything else (including missing) → expired. The client polls every 2 s, with a bound. Lightning keeps its WebSocket.
- **`GET /api/payments/config`** → `{ stripe: { enabled, publishableKey }, lightning: { enabled } }`, so key rotation and test/live never need a client rebuild.

### 1g. Store IAP — `services/storePayments.ts`, `controllers/storePaymentController.ts`, `routes/storePaymentsRoutes.ts` (new)
- **`POST /api/store/verify`** (NIP-98, mounted at `/api/store`). Body `{ platform, productId, receipt: { transactionId | purchaseToken, orderId } }` plus either `{ pubkey, nip05, tierId }` (mail) or `{ domain }` (workspace). `req.nostrPubkey` is the buyer: for mail a mismatched body `pubkey` is rejected; for workspace it must be the domain owner.
  1. Resolve `productId` in `store_products` (active, matching platform). The row supplies the app identifier to verify against, what is granted (`grants_product`, `grants_tier`, `grants_quantity`) and the product type. A body that contradicts the row is rejected. Seat counts only ever come from the row.
  2. `validateMailOrder` or `validateWorkspaceOrder` (with `seats = grants_quantity`).
  3. Idempotency pre-check: if an invoice with `invoice = <transactionId / orderId>` exists → `already_provisioned`.
  4. Verify with the store:
     - **Google**: `@googleapis/androidpublisher` `purchases.products.get({ packageName, productId, token })`, require `purchaseState == 0`; consumables also require `consumptionState == 0`.
     - **Apple**: `app-store-server-library` `SignedDataVerifier` (Apple Root CA bundled). Check `transactionId`, a bundle id matching the catalog row, and type `NonConsumable` / `Consumable` matching `product_type`. Try production, fall back to sandbox. Take the transaction's `price` (milli-units → minor units) and `currency` for `invoices.price` / `price_unit`.
  5. One transaction: `createOrder` (`payment_hash: NULL`, `invoice: <transactionId / orderId>`, provider `apple`/`google`), then `fulfilInvoice`. On a `UNIQUE(invoice)` race → `already_provisioned`.
  6. After commit, Google: non-consumable → `purchases.products.acknowledge`; consumable → `purchases.products.consume`. Both are retried on the next verify of the same token if they fail (Play auto-refunds anything not acknowledged within 3 days).
  7. Respond `{ status: 'provisioned' | 'already_provisioned' | 'needs_attention', reason?, address?, seats? }`.
- Deps `@googleapis/androidpublisher`, `app-store-server-library`, `google-auth-library`. Env `GOOGLE_SERVICE_ACCOUNT_JSON`, `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_PRIVATE_KEY_P8`, `APPLE_VERIFY_ENV=auto|production|sandbox`. App and package identifiers come from `store_products`, not env.
- `scripts/seedStoreProducts.ts`: upserts this environment's rows from env (`STORE_APPLE_BUNDLE_ID`, `STORE_GOOGLE_PACKAGE`, `STORE_SEAT_PACKS="1,10,50"`).

### 1h. Tiers endpoint
- `getMailTiers()` gains `store: { apple, google }` from `store_products`. It has no fiat price: fiat amounts only exist as quotes (`POST /api/quotes`).
- `getWorkspaceTiers()` / `seatPrice()` gain `storePacks: [{ seats, apple, google }]`.
- Backend tripwire (see Store-bundle exclusion, layer 5): `middleware/payChannel.ts` returns 403 for `X-Pay-Channel: store` on the Lightning invoice and Stripe endpoints.
- `priceSats` is unchanged, so old clients are unaffected. The backend serves every payment method to every client; which methods a build shows is a property of the client build.

### 1i. Crons and scripts
- `scripts/reconcileLightningInvoices.ts` (new) replaces `reconcilePendingMails.ts`, `reconcilePendingDomainOrders.ts` and `reconcilePendingStoragePlans.ts`. It also covers forms, which have no reconciler today. `getReconcilableInvoices({ provider: 'lightning', products: all, graceMs: 24h })` → batched relay lookup by `payment_hash` → `validatePendingReceipt` → `fulfilInvoice`. `cleanup-crontab`: three lines become one (*/15).
- `scripts/reconcileStripeInvoices.ts` (new, */5): reconcilable `provider='stripe'` invoices older than 2 min (grace 1 h) → `sessions.retrieve(payment_hash)` (rows with a NULL `payment_hash` are looked up with `sessions.list` by `client_reference_id`). Paid → fulfil with `session.payment_intent`. Expired → `expireInvoice`.
- `utils/cleanupCrons.ts`: `cleanupOldPendingForms` is deleted (nothing is deleted any more), and `cleanupExpiredForms` becomes `expireForms` (flip to `inactive`).
- `scripts/reconcileMailInvoice.ts` → `reconcileInvoice.ts`: looks up by `invoices.invoice` (BOLT11) for any product and calls `fulfilInvoice`, regardless of expiry.
- `scripts/backfillInvoiceLnInvoice.ts`, `scripts/backfillInvoicePrice.ts`: one-off backfills. If both have already run on prod, delete them. Otherwise rewrite them against `invoice` / `payment_hash` with a `provider='lightning'` filter.

### 1j. API responses and their consumers
- `/api/invoices` (own purchases) returns `status='fulfilled'` rows. `/api/invoices/all` (admin) returns every row. Both use an **explicit serializer** in place of `SELECT *`: existing keys keep their names (`id`, `product`, `pubkey`, `paymentHash` ← `payment_hash`, `price`, `price_unit`, `created_at`), `lnInvoice` becomes **`invoice`**, and `product_id`, `status`, `provider`, `expires_at`, `fulfilled_at` are added.
- `models/analytics.ts`:
  - `getInvoicesGrouped` / `listPaidUsers` read `status='fulfilled'`, with revenue totals grouped by `price_unit`.
  - Mail aliases come from `mails.nip05_id → nip05`, with the creation-order pairing kept only for legacy unlinked rows. The workspace seats come from `workspace_orders` (domain name via `domain_id → domains`), the form slug from `forms`, the storage plan from `storagePlans`, all via `product_id`.
  - `listPendingPayments` reads every product's pending invoices joined to their product rows, flagging `abandoned` (past `expires_at`). `PendingRow.lnInvoice` becomes `invoice`, and `provider`, `price`, `price_unit` are added. The workspace "unpaid domain" view keeps its shape.
  - New `listPaidNotProvisioned()`: fulfilled invoices whose product row never activated (mail `nip05_id IS NULL`, form `expirationDate IS NULL`, workspace/storage `inactive`), with the reason the fulfilment logged. Exposed under the existing analytics routes.
- Consumers (other repos), deployed **before** Deploy A and reading `invoice ?? lnInvoice` so either backend works:
  - `formstr-analytics/src/components/PendingPaymentsTable.tsx`: `lnInvoice` → `invoice`, provider/abandoned badges, the price with its unit. Plus a small "paid, not provisioned" table.
  - `nostr-storage-orchestrator/packages/console/src/types.ts`: `InvoiceRecord.lnInvoice` → `invoice`, plus `status` / `provider`. `pages/Dashboard.tsx` and `pages/Pricing.tsx` need no change (`paymentHash` keeps its key; the storage invoice response is unchanged).
  - `nostr-forms` `customSlugForm.tsx`: no change (the form invoice response is unchanged).
  - The `?? lnInvoice` fallback comes out after Deploy B.

### 1l. Admin alerts — `mailer/adminAlerts.ts` (new)
Alerts go to every row in `users` with `role = 'admin'`, as Mailstr mail through the existing bridge transport (`sendBridgeMail`), addressed by pubkey the same way the welcome mail is.
- `models/users.ts`: add `listUsersByRole(role)`. `service` rows never get mail.
- `sendAdminAlert(event, data)`:
  - loads the admins and renders the alert;
  - sends one `sendBridgeMail({ to: adminPubkey, from: ALERTS_FROM, subject, text, html })` per admin, in parallel;
  - logs the outcome (sent / failed per admin; "no admins configured" when the query is empty; "bridge not configured" comes from the bridge client).
  - **Best-effort**: it never throws, it's only called after the business transaction has committed, and a mail failure never affects a purchase, webhook response or verify response.
- Content: `mailer/templates/admin-alert.md` (front matter `subject`, a `footerNote`), rendered with the existing `loadTemplate` → `markdownToText` / `renderBrandedEmail`, like `welcome.ts`. Each mail carries: event, product, invoice id, provider, buyer pubkey (npub), amount (`price price_unit`), the `payment_hash` and `invoice` references (zap key / Checkout Session, BOLT11 / PaymentIntent / store transaction), and the reason. It also links to the analytics "paid, not provisioned" view.
- Env: `ALERTS_FROM` (defaults to `Mailstr alerts <alerts@${MAIL_DOMAIN}>`).
- Events:

  | Event | Sent from | Trigger |
  |---|---|---|
  | `paid_not_provisioned` | `fulfilInvoice` | any `needs_attention` result: address/slug taken, domain gone/suspended, storage plan no longer applies |
  | `stripe_refund` | Stripe webhook | `charge.refunded` (includes the linked invoice, found by `invoice = <payment_intent>`) |
  | `stripe_dispute` | Stripe webhook | `charge.dispute.created` |

- Duplicates: `paid_not_provisioned` is sent once per invoice (only the claiming call sends it). Stripe can redeliver refund/dispute events, so their subject includes the Stripe event id and a redelivery is recognisable. This plan adds no dedupe table.
- `ADMIN_PUBKEY` (env) isn't used for alerts. It keeps its existing job: the pubkey that reserved names resolve to in `nip05Controller`.

### 1k. Tests (jest, existing style)
- `adminAlerts.test.ts` (mocked `sendBridgeMail` and users model): one mail per admin, `service` users excluded; no admins → logged, no throw; a bridge failure for one admin doesn't stop the others; the rendered mail contains the invoice id, amount and reason.
- Alert wiring: `needs_attention` triggers exactly one alert, a replay triggers none, and an alert failure doesn't change the fulfilment result. The Stripe refund/dispute webhook handlers send alerts and still return 200.
- `invoiceFulfilment.test.ts`, per product:
  - the claim is exclusive (two concurrent calls → one `fulfilled`, one `already_fulfilled`);
  - the product row goes `inactive → active` only on success;
  - a thrown product write rolls back and the invoice stays pending;
  - each `needs_attention` case leaves the invoice fulfilled and the product inactive;
  - workspace seats are added exactly once;
  - storage: orchestrator failure rolls back, and a retry after a lost commit doesn't double-grant (mocked grant keyed by hash);
  - form: an active-slug conflict → `needs_attention`, and `expirationDate` is set at activation;
  - an abandoned invoice can still be fulfilled.
- `fiatQuote.test.ts`: property test over random `N`, fee profiles and exponents: `G − fee(G) ≥ N` and `(G − 1) − fee(G − 1) < N` (minimal); the worked example (500 → 546); zero-decimal currencies (JPY); the minimum-charge clamp; seats converted once on the total; rounding up. `fxRate.test.ts`: median of sources, one source down, sources disagreeing → refuse, stale rate → refuse, cache hit. `quoteToken.test.ts`: signature, expiry, order mismatch, config sats change. A quote endpoint test that nothing is written to the database.
- `orderValidation.test.ts`: taken address / active slug rejected; the seat cap includes existing seats; storage mode rules.
- `orders.test.ts`: the product row (`inactive`) and the invoice are created atomically for each product; two inactive form orders for one slug coexist.
- `stripePayments.test.ts` (mocked `stripe`): checkout uses the amount and currency from the verified quote, sets `managed_payments.enabled`, `tax_behavior: 'exclusive'` and a tax code, and sends none of the unsupported parameters; an expired, tampered, wrong-order or stale-sats-price quote → 409; webhook happy path (the paid amount and currency checked against the invoice); bad signature → 400; amount/currency mismatch rejected; `payment_hash` is set to the session id after creation; the webhook falls back to `client_reference_id` when that write was lost; `invoice` gets the PaymentIntent at fulfilment; a refund event resolves by PaymentIntent; duplicate delivery idempotent; fulfilment error → 500; expiry marks the invoice expired without deleting it; pubkey mismatch → 403.
- `storePayments.test.ts` (mocked androidpublisher + Apple verifier):
  - mailbox: happy path; re-verify idempotent; unpaid `purchaseState` rejected; reserved/taken name blocked; pubkey mismatch rejected; unknown/inactive SKU rejected;
  - seat pack: seats come from the catalog only; a non-owner is rejected; an already-consumed token is rejected; consume is called once after commit; the type must match `product_type`.
- Rework `zapReceiptHandler.test.ts`, `receiptValidation.test.ts`, `workspaceProvisioning.test.ts` / `storageProvisioning.test.ts` (both become part of the fulfilment tests), `storageSubscription.test.ts`, `paymentController.test.ts`, `mailController.test.ts`, and the reconcile tests. Add checks that the Lightning reconciler skips Stripe/store rows and orders past the grace period. Add a cleanup test that expired forms are flipped, not deleted.
- Migration test on a scratch DB (see Migrations).

**Not changing:** zap listener, relays, `paymentManager`, the orchestrator API.

---

## Phase 2 — Frontend payments module (nail, `client/web/src/lib/payments/`)

Payment logic stays **inside nail** (no shared package), pulled out of `SignupWizard` into one module so the wizard and the seats panel stay thin (repo rules 2, 3, 8). A later move to common-packages would be a move, not a rewrite.

```
client/web/src/lib/payments/
  channels.ts     CHANNEL_METHODS matrix + methodsForBuild() (+ test)
  methods.ts      build-time composition of the methods (dynamic import per payment method)
  client.ts       tiers, payments config, lightning invoice (mail/workspace), stripe checkout, store verify, order status
  status.ts       pollOrderStatus (bounded), watchLightning (existing WS)
  iap.ts          dynamic import of the Capacitor IAP plugin (fetchProducts / requestPurchase / finish / pendingTransactions / restorePurchases)
client/web/src/components/payments/
  PaymentSheet.tsx   picks the payment-method UI; renders MethodPicker when >1 method
  MethodPicker.tsx   segmented control (wireframe §2), Lightning first
  CurrencySelect.tsx currency list (display switcher on the name step; the choice on the Card panel; wireframes §1, §2)
  LightningPay.tsx   today's InvoiceQR, moved unchanged
  StripePay.tsx      Embedded Checkout (hosted via @capacitor/browser in a native shell)
  StorePay.tsx       mailbox purchase + Restore purchases, or seat-pack picker + purchase
```

- `PaymentSheet` props: `product: 'mail' | 'workspace'`, `order` (`{ tierId, nip05 }` or `{ domain, seats }`; `{ domain, pack }` in store builds), `onPaid`. A `needs_attention` result renders its reason as a terminal error, never a spinner.
- **Lightning first, everywhere.** `CHANNEL_METHODS` orders open builds `['lightning','stripe']`. The picker lists Lightning first and **defaults to it**. A remembered choice (`zustand/persist`, key `mailstr.pay.method`) overrides the default. This is about **payment methods**, not price display.
- **Price display is fiat-first, with a currency select.** Name-step tier cards and the seats panel show an indicative price in the chosen currency by default (no sats up front), via `POST /api/quotes` (token ignored). If Stripe is off or quoting fails (503, network), they fall back to the sats price with no currency select and no error banner (wireframe §1). A small "Show prices in [USD ▾]" select (`components/payments/CurrencySelect.tsx`) offers the backend's currency list plus **sats**. The choice is remembered (`zustand/persist`, key `mailstr.pay.currency`) and seeds the Card panel's currency. Defaults: the last choice, else the browser locale's currency if it is in the list, else USD.
- **The pay step always shows each method's own charge.** Lightning: sats. Card: a currency select, then the **quoted amount** with its expiry and one "Accept and pay" button; accepting calls `POST /api/stripe/checkout` with the `quoteToken`, and Checkout mounts after the 200. On a 409 the panel fetches a new quote and asks for acceptance again. Card is hidden when the quote endpoint returns 503 (stale rates), leaving Lightning.
- **Store builds have no switcher**: the store's localized price only, no sats.
- The Lightning sats parsing stays inside the Lightning module (see Store-bundle exclusion), so the switcher is only mounted on open builds.
- **Dead-code elimination is the compliance mechanism.** `methods.ts` composes the methods behind the build-time constant `import.meta.env.VITE_STORE_BUILD`, with **dynamic imports per payment method**, so Rollup drops the Lightning/QR and Stripe chunks from store bundles. A runtime switch would defeat this.
- Lightning invoices and Stripe sessions are requested **lazily, on selection**: opening the sheet on Lightning never creates a Stripe session, and choosing Card never creates a Lightning invoice or relay listener.
- Stripe: `@stripe/stripe-js` + `@stripe/react-stripe-js` (rule 13, proven libraries), loaded only inside `StripePay`. The publishable key comes from `/api/payments/config`. Checkout shows the currency the buyer chose and accepted.
- `iap.ts`: a thin wrapper over the Capacitor IAP plugin (candidate `capacitor-iap`: Capacitor 7, StoreKit 2, Play Billing, **must support consumables and deferred finish**; verify its API when implementation starts. Fallback: a capacitor-community plugin or a minimal native bridge). It returns normalized receipts `{ platform, productId, transactionId?, purchaseToken?, orderId? }` and is only `import()`ed under `isStoreBuild()`.
  - Consumables are finished only after verify succeeds.
  - On app start, `pendingTransactions()` re-sends anything unfinished to verify.
- Store errors: a cancelled purchase retries silently; store failure and verification failure get a retry button.
- Tests: vitest for `channels`, `client`, `status`; component tests for the picker and each payment method against a mocked client; Playwright e2e in Phase 5.

### Store-bundle exclusion (hard rule)

**Nothing Lightning- or Stripe-related may ship in a store build (Play AAB, iOS IPA): no code, no copy, no endpoints, no native config.** Several independent layers, so one mistake can't ship it:

1. **Compose behind a build constant.** Only `lib/payments/methods.ts` may import the Lightning and Stripe modules (dynamic `import()`), and only behind `import.meta.env.VITE_STORE_BUILD`, so Rollup removes them from store bundles. An ESLint `no-restricted-imports` rule bans importing `components/payments/LightningPay`, `components/payments/StripePay` and `@stripe/*` / `qrcode.react` from anywhere else.
2. **No Lightning vocabulary in shared code.** A bundle contains every string reachable from shared modules, so the store build can only be clean if shared code doesn't name the rails. Concretely, from today's source:
   - `lib/api.ts` (`priceSats`, `unit: "sats"`, "Lightning invoice") and `app/lib/api/workspace.ts` (`pricePerSeatSats`) parse sats fields in shared code. Move that parsing into the Lightning method's module; the shared tier model carries optional `lightning?: { priceSats }`, `fiat?`, `store?`.
   - `app/components/workspace/billing.tsx` ("One-time payment in sats", `{total} sats`) moves its amount copy into the Lightning/Stripe/Store method components.
   - `pages/privacy-policy.md` line 50 ("Bitcoin Lightning invoice settled as a Nostr zap…") and the `HelpSection` hint ("how Lightning payments work") get a store variant: `privacy-policy.store.md` selected by the same build constant, and a neutral hint. Open builds keep the full wording.
3. **Post-build guard (fails the build).** `client/scripts/check-store-bundle.mjs` scans **every file** in the store `www/` output (including chunks nothing references, and source maps if any exist) plus `AndroidManifest.xml` / `Info.plist`, case-insensitively, for a denylist: `lightning`, `bolt11`, `lnbc`, `webln`, `zap`, `sats`, `stripe`, `js.stripe.com`, `/api/generate-invoice`, `/api/workspace/generate-invoice`, `/api/stripe`, `/api/quotes`, `/api/payments/currencies`, `/api/payments/config`, `/ws?hash`, `lightning:`. Any hit fails with file + context. The denylist is calibrated against the first store build; any allowlisted false positive (e.g. a vendored word like "zap" inside an unrelated library string) needs a one-line written justification in `check-store-bundle.allow.json`, reviewed like code.
4. **Release tasks depend on the guard.** `bundlePlayRelease` and the iOS archive script run it first; CI runs it on every PR touching `client/` or `client/web/`. It also asserts the build really was a store build (the flag is baked into the bundle) so a Lightning bundle can't be packaged by mistake. A second check asserts the **open** build still contains Lightning and Stripe (catches an accidental global removal).
5. **Server-side tripwire.** Store builds send `X-Pay-Channel: store`. The backend refuses every Lightning and Stripe endpoint for that header with 403: `generate-invoice/*`, `/api/workspace/generate-invoice`, `/api/stripe/*`, `/api/quotes`, `/api/payments/currencies` and `/api/payments/config` and logs it. A client can lie, so this isn't a security control; it turns a regression in layers 1 to 4 into a loud, immediate failure in testing instead of a store rejection.
6. The quote client, `CurrencySelect` and the Card panel live in the Stripe method module, so they are covered by layers 1 to 4 like any other Stripe code.
7. **Test.** A vitest builds both variants of `methods.ts` and asserts the store variant's module graph contains no Lightning/Stripe module; Playwright runs the wizard and seats panel against a store build and fails if a request to a denylisted endpoint is made.

## Phase 3 — Integration

1. `lib/platform.ts`: `isStoreBuild()` (`VITE_STORE_BUILD === '1'`, build-time, **not** `isNativeApp()`: the direct APK is native but isn't a store build).
2. **Mail: `SignupWizard.tsx`** (428 lines, over the 300 target): the pay step becomes `<PaymentSheet product="mail" order={{ tierId, nip05 }} onPaid={() => setStep('keys')} />`. Delete `requestInvoice`, the `invoice` state, `generateMailInvoice` / `paymentSocket` / `MailInvoice` from `lib/api.ts`, and the old `InvoiceQR` usage (rule 14). Extract the login effect into `useSignupLogin` in the same change, to get under the size alarm.
3. **Workspace: `app/components/workspace/billing.tsx` `SeatsPanel`**:
   - Open builds keep the free seat-quantity input and pay through `<PaymentSheet product="workspace" order={{ domain, seats }} onPaid={paid} />`.
   - Store builds replace the input with a pack picker (1 / 10 / 50, store-localized prices).
   - `app/lib/api/workspace.ts` seat-invoice calls move to `lib/payments/client.ts`.
4. `NameStep`: price row per wireframe §1 (**fiat by default with the currency switcher** on open builds; store price only, no switcher, in store builds). The CTA stops naming a payment method and stops saying "Preparing invoice…".
5. `BuyAddressModal` / `.landing` scoping is unchanged.
6. `SettingsModal` hint and `PrivacyPolicy.tsx`: wording that doesn't name a payment method. Disclose that card purchases are sold through Stripe Managed Payments (Stripe/Link is the merchant of record: it collects the buyer's name, billing address and card details, sends the receipt, and we never receive card data), that Lightning zap receipts stay public, and store billing in store builds.
7. Per repo rule 15, log the ADRs "DCE-based payment-method exclusion" and "unified invoices table with product status" in `docs/Session-Log.md`.
8. Forms and storage frontends (nostr-forms, the storage console) keep their Lightning flows. Their API responses are unchanged, so they need no change beyond the `invoice` key in 1j.

## Phase 4 — Mobile wiring

- **Build script**: `client/scripts/build-web.mjs` takes `--store` (or `STORE_BUILD=1`) and adds `VITE_STORE_BUILD: '1'` to the web build env. `client/package.json` wraps both as `build:web` (open) and `build:web:store`.
- **Android flavors**: `flavorDimensions "distribution"` in `app/build.gradle` with `direct` and `play`. `scripts/toggle-iap.mjs` runs after every `cap sync` and removes or re-adds the IAP plugin lines in `capacitor.settings.gradle` / `capacitor.build.gradle`, so the flavors really differ at the native level.
  - **`direct` APK** (Lightning + Card, zero Google): `npm run build:web && npm run sync && node scripts/toggle-iap.mjs --off && ./gradlew assembleDirectRelease`. No Play Billing, no Play Services, no google-services plugin, no Firebase (never commit `google-services.json`; the notifier keeps WorkManager polling). Stripe here is hosted Checkout in a Custom Tab via `@capacitor/browser`, with a `com.formstr.mail://pay-return` (or https app-link) intent filter. Stripe's Android SDK is **not** used, which keeps the zero-Google guarantee provable.
  - **`play` AAB** (IAP only): `npm run build:web:store && npm run sync && ./gradlew bundlePlayRelease`. Always rebuild web before each artefact. The release task fails if `www/` was built without the store flag.
  - Play release signing (keystore via env or an uncommitted `keystore.properties`), a versionCode scheme, and plugin ProGuard keep rules if its docs require them. Test on the internal track with license testers.
- **iOS** (store-only): `@capacitor/ios`, `npx cap add ios` (macOS + Xcode + Apple Developer Program), bundle id `com.formstr.mail`, always built with `build:web:store`. StoreKit 2 comes through the plugin. A `.storekit` config with the mailbox and the three seat packs for local Xcode testing, then sandbox devices. Submission assets: privacy policy URL, support URL, screenshots, privacy labels (pubkey + purchase record).
- **Compliance check in the build**: `check-store-bundle.mjs` (see Store-bundle exclusion) gates `bundlePlayRelease` and the iOS archive. The direct APK must not contain `com.android.billingclient` or Google services classes (apkanalyzer).

## Phase 5 — Verification

1. Backend: `npx tsc --noEmit` and `npx jest`; migrations up/down/up on a staging dump, for both deploys (see Migrations).
2. **Stripe, test mode**:
   - `stripe listen`; test cards `4242…` (success), `4000 0000 0000 9995` (decline), a 3DS card;
   - Quotes: for several currencies (including JPY, zero-decimal), the quoted amount minus the configured fee equals the intended amount; in the Stripe sandbox, a real test charge's fee compared with the configured fee and the net balance transaction compared with `N`; a stale rate makes Card disappear; an expired quote forces re-acceptance; a Managed Payments Checkout Session shows the quoted amount before tax in the quoted currency, adds tax for different `test+location_XX@example.com` buyers, and the sandbox balance transaction's net (`fee` and `withheld_tax` reports) equals `N`; embedded Checkout works under Managed Payments; for a buyer located in another country, check what Checkout shows and whether the integration currency can be chosen;
   - `stripe trigger` for refund/dispute logging;
   - webhook retry: kill the backend mid-delivery and confirm Stripe redelivers, ending with one active mailbox, one fulfilled invoice, one `nip05`.
3. **Lightning regression (web), all four products**:
   - an inactive product row + pending invoice appear on order and flip to `active` / `fulfilled` on payment;
   - workspace seats are added once; the storage entitlement is assigned once; the form slug resolves only once paid;
   - legacy rows read `provider='lightning'`, `status='fulfilled'`; legacy products are `active` (unexpired forms only);
   - `/api/invoices` returns `invoice`; the analytics pending, paid-not-provisioned and products views render; the storage console, the storage purchase history and the nostr-forms custom slug flow work;
   - the single reconciler fulfils a stranded paid order for each product (including forms, which had none) and skips Stripe rows and long-abandoned orders;
   - abandoned orders are still present and flagged; expired forms are `inactive`, not deleted, and their slug can be bought again;
   - ordering a taken address / active slug is refused.
4. **Between A and B**: confirm the old columns are still written (dual-write) and nothing reads them. After B: confirm the dropped tables/columns aren't referenced (`grep`), and that M11 picked up any stragglers.
5. **Store-bundle exclusion**: run `check-store-bundle.mjs` on a real store build and on the open build (must pass / must still find Lightning+Stripe); temporarily import `LightningPay` statically from the wizard and confirm lint, the vitest module-graph test and the guard each fail; send `X-Pay-Channel: store` to a Lightning and a Stripe endpoint and confirm 403.
6. Wizard and seats-panel e2e (Playwright, mock backend): open builds show Lightning (default) then Card; store builds show the mailbox SKU and the seat-pack picker. No Lightning invoice is created until Lightning is selected. The success path goes through `GET /api/orders/:sessionId/status`. A `needs_attention` result shows its reason.
7. Android:
   - `play` internal track: mailbox purchase and restore; buy the same seat pack twice (proves consumption); kill the app between purchase and verify, relaunch, and confirm the pending purchase is verified and consumed once.
   - `direct` APK: Lightning, plus a Stripe hosted round-trip with the app killed mid-checkout (order status resumes). apkanalyzer check.
   - iOS: the same in sandbox, then TestFlight.
8. Idempotency: replaying the webhook, store verify or a zap receipt gives a single fulfilled invoice, a single `nip05` / form / grant, and seats added once.
9. **Admin alerts on staging**: with two `admin` rows in `users`, force a `needs_attention` (pay for an address that has just been taken) and `stripe trigger charge.refunded`. Each admin receives one mail per event in the Mailstr client. Replaying the receipt sends nothing.

## Phase 6 (follow-up, out of scope)
- Stripe (and, where store policy needs it, IAP) for forms and storage. Storage is a 30-day renewing plan: one-off vs Subscriptions. The data model needs no change for either.
- Refund handling across payment methods (Stripe `charge.refunded` / disputes, Google RTDN, App Store Server Notifications V2 → flip the product row back to `inactive` and revoke).
- Stripe Tax if chosen; multi-tier store SKUs.

## Dependency order
1. Phase 0, including looking up Stripe's fees for the payment methods and currencies you enable.
2. Consumer updates (`formstr-analytics`, storage console) reading `invoice ?? lnInvoice`.
3. Phase 1 on the feature branch → **Deploy A** (M1–M10, including M1a).
4. Phase 2 can start against mocks once the §1f/§1g contracts are agreed.
5. Phase 3; Lightning (all products), Stripe and store IAP can go live on Deploy A.
6. Verify A in prod → `pg_dump -t mails -t storagePlans` → **Deploy B** (M11–M13).
7. Phase 4: store IAP goes live (no longer depends on Deploy B, thanks to M1a).
8. Phase 5 runs alongside each step.

## New environment values

Everything here is **new**. Backend values go in `formstr-backend/.env` (and `.env.example`, which documents each one); the two client values are build-time. Secrets are never committed, and staging and production use different values (Stripe test keys vs live keys, sandbox vs production store accounts). Existing values this plan reuses unchanged: `MAIL_PRICE_SATS`, `WORKSPACE_SEAT_PRICE_SATS` (the only prices; fiat is derived from them), `BRIDGE_SEND_URL` / `BRIDGE_SEND_API_KEY` (admin alert mail), `MAIL_DOMAIN`.

### Backend: Stripe (card)

| Name | Required | Default | Used for |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | to enable card | unset = card payments off | Server-side Stripe API calls (create Checkout Sessions, retrieve sessions in the reconcile cron). Use a **restricted key** (Checkout Sessions write; PaymentIntents and Charges read). Test key on staging, live key in production |
| `STRIPE_PUBLISHABLE_KEY` | with the secret key | none | Served to the client by `GET /api/payments/config` so Stripe.js can mount Checkout; changing it needs no client rebuild |
| `STRIPE_WEBHOOK_SECRET` | with the secret key | none | Verifies the signature of every call to `POST /api/stripe/webhook` (separate secret per environment and per webhook endpoint) |

### Backend: fiat quotes and the exchange rate

| Name | Required | Default | Used for |
|---|---|---|---|
| `FIAT_CURRENCIES` | with the secret key | none (suggest `usd,eur,gbp,cad,aud,chf,jpy`) | Currencies offered in the card currency list. Intersected with what the rate feed quotes and Stripe supports |
| `STRIPE_FEES` | with the secret key | none, startup error if missing or invalid | JSON of Stripe's fees used to gross up the card price so the net equals the intended amount: `{"default":{"percent":0.029,"fixed":30},"eur":{"percent":0.039,"fixed":25}}`. `percent` is a fraction, `fixed` is in minor units. `default` is required. Use Stripe's real Managed Payments rates |
| `QUOTE_SECRET` | with the secret key | none, startup error if missing | HMAC key that signs and verifies quote tokens. At least 32 random bytes; rotating it invalidates open quotes (buyers just re-quote) |
| `QUOTE_TTL_SECONDS` | no | `600` | How long an accepted-or-not quote stays valid for `POST /api/stripe/checkout` |
| `FX_SOURCES` | no | set when implementing (at least two public BTC price tickers) | Which price sources the rate service queries. The median of the sources is used; fewer than two agreeing sources means card quoting returns 503 |
| `FX_CACHE_SECONDS` | no | `60` | How long a fetched rate is reused before refetching |
| `FX_MAX_AGE_SECONDS` | no | `600` | A rate older than this is not used; quoting returns 503 and the client shows sats/Lightning only |
| `FX_MAX_DEVIATION` | no | `0.01` | Largest allowed spread between sources (as a fraction) before the quote is refused |

### Backend: store purchases (Apple / Google)

| Name | Required | Default | Used for |
|---|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | for Google IAP | none | Service account (inline JSON or a file path) the backend uses to verify purchases, acknowledge mailboxes and consume seat packs through the Play Developer API |
| `APPLE_KEY_ID` | for Apple IAP | none | Key id of the App Store Server API key |
| `APPLE_ISSUER_ID` | for Apple IAP | none | Issuer id for the same key |
| `APPLE_PRIVATE_KEY_P8` | for Apple IAP | none | The `.p8` private key (inline or a file path); signs App Store Server API requests |
| `APPLE_VERIFY_ENV` | no | `auto` | `auto` tries production then sandbox; `production` or `sandbox` pins it |
| `STORE_APPLE_BUNDLE_ID` | to seed products | none | Bundle id this environment's `store_products` rows verify against (read only by `scripts/seedStoreProducts.ts`) |
| `STORE_GOOGLE_PACKAGE` | to seed products | none | Play package name for the same purpose |
| `STORE_SEAT_PACKS` | to seed products | `1,10,50` | Seat pack sizes the seed script creates as consumable SKUs |

### Backend: admin alerts

| Name | Required | Default | Used for |
|---|---|---|---|
| `ALERTS_FROM` | no | `Mailstr alerts <alerts@${MAIL_DOMAIN}>` | The From address of admin alert mails (paid-but-not-provisioned, Stripe refunds and disputes) |

### Client (nail) build

| Name | Where | Default | Used for |
|---|---|---|---|
| `VITE_STORE_BUILD` | web build (set by the build script) | unset (open build) | `1` marks a store build. It is a compile-time constant, so Lightning and Stripe code is removed from the bundle; it also makes the client send `X-Pay-Channel: store` |
| `STORE_BUILD` | `client/scripts/build-web.mjs` environment (or the `--store` flag) | unset | Tells the build script to produce the store bundle (`build:web:store`) |

Android Play signing (keystore path and passwords) and any Apple signing settings are not new application config; they live in an uncommitted `keystore.properties` / CI secrets, as in Phase 4.

### Removed from earlier drafts
`STRIPE_CURRENCY`, `MAIL_PRICE_FIAT` and `WORKSPACE_SEAT_PRICE_FIAT` no longer exist: there is no fixed fiat price, only the sats prices and the live quote.

## Touchpoint index (formstr-backend unless noted)

| File | Change |
|---|---|
| `migrations/20261020100000…100900_*.ts` | new, expand (M1–M10, including M1a) |
| `migrations/20261103100000…100200_*.ts` | new, contract (M11–M13), separate PR |
| `src/db.ts` | new shared knex handle |
| `src/models/invoices.ts` | rewritten (new columns, claim, expire, temporary dual-write) |
| `src/models/mails.ts`, `form.ts`, `storagePlan.ts`, `types.ts` | `status`; active-only reads; inactive create / activate; mail expiry and storage `payment_hash` removed; `PendingForm` removed |
| `src/models/workspaceOrders.ts`, `src/models/storeProducts.ts` | new |
| `src/models/pendingMail.ts`, `pendingDomainOrder.ts`, `pendingForm.ts`, `pendingStoragePlan.ts`, `utils.ts` | deleted |
| `src/models/analytics.ts` | fulfilled-only ledger reads, joins via `product_id`, pending + abandoned + paid-not-provisioned from invoices, per-unit totals, `lnInvoice` → `invoice` |
| `src/services/orderValidation.ts`, `orders.ts`, `invoiceFulfilment.ts` | new |
| `src/services/mailProvisioning.ts`, `workspaceProvisioning.ts`, `storageProvisioning.ts` | replaced by `invoiceFulfilment.ts` |
| `src/services/receiptValidation.ts` | expectations from invoice + product row for every product |
| `src/services/storageSubscription.ts` | active-only plans; prices via `product_id` |
| `src/services/seats.ts` | `addSeats` accepts `trx` |
| `src/handlers/zapReceiptHandler.ts` | everything via `fulfilInvoice`; WS message on every result; ledger insert removed |
| `src/controllers/paymentController.ts` | all four handlers via `validate*Order` + `createOrder`; no mail expiry; form expiry moved to fulfilment; form invoice pubkey = owner |
| `src/controllers/mailController.ts`, `formController.ts` | admin/free paths insert `active` rows |
| `src/controllers/invoicesController.ts` | explicit serializer, fulfilled filter for own purchases |
| `src/controllers/stripeController.ts`, `storePaymentController.ts`; `src/routes/stripeRoutes.ts`, `storePaymentsRoutes.ts`; `src/services/stripePayments.ts`, `storePayments.ts` | new |
| `src/index.ts` | raw-body webhook mount before `express.json()`; new routes |
| `src/utils/tiers.ts`, `src/utils/workspacePricing.ts` | `store` / `storePacks` (no fiat price) |
| `src/services/fxRate.ts`, `src/services/fiatQuote.ts`, `src/controllers/quoteController.ts`, `src/routes/quoteRoutes.ts` | new: rate feed, conversion + fee gross-up + signed quote, `POST /api/quotes`, `GET /api/payments/currencies` |
| `src/utils/bolt11.ts` | `parseBolt11Expiry` |
| `src/mailer/adminAlerts.ts`, `src/mailer/templates/admin-alert.md` | new: admin alert mails via the bridge |
| `src/models/users.ts` | `listUsersByRole` |
| `src/config/environment.ts` | add `ALERTS_FROM` |
| `src/utils/cleanupCrons.ts` | delete `cleanupOldPendingForms`; `cleanupExpiredForms` → `expireForms` |
| `src/scripts/reconcileLightningInvoices.ts`, `reconcileStripeInvoices.ts`, `seedStoreProducts.ts`, `reconcileInvoice.ts` | new (`reconcileInvoice.ts` replaces `reconcileMailInvoice.ts`) |
| `src/scripts/reconcilePendingMails.ts`, `reconcilePendingDomainOrders.ts`, `reconcilePendingStoragePlans.ts`, `reconcileMailInvoice.ts` | deleted |
| `src/scripts/backfillInvoiceLnInvoice.ts`, `backfillInvoicePrice.ts` | delete if already run, else port |
| `cleanup-crontab` | one Lightning reconciler, add Stripe reconciler |
| `formstr-analytics/src/components/PendingPaymentsTable.tsx` (+ paid-not-provisioned table) | `invoice ?? lnInvoice`, badges, price with unit |
| `nostr-storage-orchestrator/packages/console/src/types.ts` | `invoice`, `status`, `provider` |
| `nail/client/web/src/lib/payments/*`, `components/payments/*` | new |
| `nail/client/web/src/components/SignupWizard.tsx`, `app/components/workspace/billing.tsx`, `lib/api.ts`, `app/lib/api/workspace.ts`, `lib/platform.ts` | Phase 3 |
| `nail/client/{package.json,scripts/build-web.mjs,scripts/toggle-iap.mjs,android/,ios/}` | Phase 4 |
| `nail/client/scripts/check-store-bundle.mjs` (+ allow file), `nail/client/web/src/pages/privacy-policy.store.md`, ESLint config | store-bundle exclusion |
| `formstr-backend/src/middleware/payChannel.ts` | new: 403 for `X-Pay-Channel: store` on Lightning/Stripe endpoints |

## Decisions (Oct 18 2026) and the one open item

Decided:
1. **Direct APK payment methods** = Lightning + Card (store billing is impossible outside Play).
3. **Store seat packs** = 1 / 10 / 50.
4. **NOT NULL** on the new `status` / `provider` columns, added in Deploy B (M13) with `dropNullable()`.
5. **Forms and storage** move to the unified model here but stay Lightning-only. Stripe/IAP for them is a follow-up.
6. **Form expiry** flips the form to `inactive` (row and history kept, slug freed by the partial unique index) instead of deleting it.

Open (business / legal decisions, none blocks the design):
- **Fee profile.** One `STRIPE_FEES` entry can't match every card and payment method. Conservative (the dearest realistic card) never nets you less than the intended amount and over-collects a little elsewhere. Common-case nets exactly the intended amount on typical cards and slightly less on dearer ones. Recommendation: conservative.
- **Card pricing vs Lightning pricing.** The card price includes Stripe's fees and is shown as one price, never itemised. Have a lawyer or accountant check whether that counts as a card surcharge in the jurisdictions you sell into (EU/UK consumer-card rules, some US states, card-network rules).
- **Currency list vs Managed Payments.** Adaptive Pricing can't be disabled under Managed Payments, so Stripe may show a buyer their local currency instead of the one picked from our list (with a 2 to 4% conversion fee for them). Option A (as planned): keep the list, default it to the buyer's locale currency, test what Checkout does. Option B: a single integration currency (USD) for Card, Stripe localizes, no list. Recommendation: A, then fall back to B if the sandbox shows frequent mismatches. Also the starting list for `FIAT_CURRENCIES` (suggest USD, EUR, GBP, CAD, AUD, CHF, JPY) and the quote lifetime (default 10 minutes).
- **Refunds Stripe starts.** Stripe may refund within 60 days on its own. Should a refunded purchase automatically deactivate the mailbox or seats (flip the product row to `inactive`), or only alert the admins? Recommendation: auto-deactivate for mail; for seats, alert first (reducing seats under used addresses needs a policy).
- **Managed Payments facts to confirm** before launch: Stripe's own fee numbers; embedded Checkout under Managed Payments; tax code choice (accountant); whether the percentage fee is taken on the amount including tax.

## Key risks
- **Embedded Checkout inside the Capacitor WebView** is unverified. Hosted Checkout is the designed fallback; decide after a device test.
- **Rate feed**: a bad or manipulated BTC price changes what buyers are charged. Mitigated by the two-source median, the deviation and stale-rate refusals, and the sanity bound; a feed outage only disables Card (Lightning keeps working).
- **Fee drift**: if Stripe changes its pricing or a buyer pays with a method whose fee differs from the configured profile, the net differs slightly from the intended amount. Review the config when Stripe's pricing changes, and compare a sample of balance transactions after launch.
- **Managed Payments dependency**: eligibility depends on a low dispute rate and a supported business location; if Stripe ends eligibility, card sales stop until another tax setup (Stripe Tax and your own registrations) is in place. Stripe also controls the checkout page, the receipts and the payment methods offered.
- **Currency double conversion**: a buyer who picked one currency but is located elsewhere may be shown a third amount by Adaptive Pricing; covered by testing and by the A/B decision above.
- **Webhook ordering**: the browser may report done before the webhook lands. Status polling is bounded at 2 minutes, then shows "still confirming, you'll get your mailbox shortly" (the cron and Stripe retries finish the job).
- **Storage fulfilment holds a DB transaction across the orchestrator call**. It's short and bounded by the client timeout, and it's safe because the orchestrator grant is keyed by `payment_hash`. Set a tight HTTP timeout so a slow orchestrator doesn't hold locks.
- **Partial unique index via knex** (`predicate` on `unique`/`index`): confirm knex 3.1 emits `CREATE UNIQUE INDEX … WHERE` for Postgres. Fallback: `index(['slug'], name, { indexType: 'unique', predicate })`, still builder-only.
- **Consumable seat packs**: a purchase that's verified but not consumed/finished blocks re-buying the same pack (Google) or replays on launch (Apple). Handled by consume-after-commit, retry on re-verify, and the start-up pending-transaction sweep; covered by the kill-the-app test. The IAP plugin must support deferred finish.
- **Store review for seats**: Apple may ask why seats for a business domain are sold in-app. That's expected; IAP is the required mechanism for digital services consumed in the app.
- **Deploy window between M9 and the new code starting**: an order placed by the old code in those seconds lands in a legacy pending table. M11 picks it up at Deploy B. Until then, if it's paid it's only provisioned by running `reconcileInvoice.ts` by hand. Keep Deploy B close to A.
- **Legacy linking** for mail and form ledger rows (M9 step 5) is heuristic. Unmatched rows stay `product_id NULL`, and analytics falls back to today's behaviour for them, so nothing regresses.
- **Rolling back Deploy A after Stripe or IAP are live** is lossy: M1a's `down()` refuses to run while Stripe/store invoices (NULL `paymentHash`) exist. Roll forward instead.
- **IAP plugin choice**, **Apple review prerequisites** (Paid Applications Agreement and IAP metadata before sandbox works), the **Android acknowledge window** (3 days), and **mailbox restores being store-account-scoped, not nostr-key-scoped** (a restore on a different key provisions that key).
- **Admin alerts depend on the bridge**: if `BRIDGE_SEND_URL` is down or unset, alerts are only logged. The analytics "paid, not provisioned" view is the backstop, because it reads the database, not mail.
- **Policy**: Stripe must never ship in a store bundle. That's enforced by DCE plus the bundle grep (Phase 4), not by convention.
