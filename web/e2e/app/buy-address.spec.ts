import { test, expect } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

// Any valid 64-char hex works as the bridge's resolved pubkey — it just has to
// be non-null so the app treats the local domain as reachable.
const BRIDGE_PK = 'a'.repeat(64)
const ALIAS = 'zoe@mailstr.app'
const PAYMENT_HASH = 'f'.repeat(64)

/**
 * The in-app buy flow: the sidebar's "Buy a new address" row opens the
 * landing's purchase wizard as a modal over the current page (it used to
 * new-tab to `/?buy=1`, a clunky round-trip), steps straight to address
 * selection with the live session, and a completed purchase closes the modal
 * and refreshes the sidebar alias list in place.
 */
async function stubNip05(page: import('@playwright/test').Page, owned: boolean) {
  await page.route('**/.well-known/nostr.json*', (route) => {
    const url = new URL(route.request().url())
    const names: Record<string, string> = { _smtp: BRIDGE_PK }
    // `zoe` is free until "paid", owned afterwards; every other lookup empty.
    if (url.searchParams.get('name') === 'zoe' && owned) names.zoe = 'd'.repeat(64)
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ names }),
    })
  })
  await page.route('**/get-nip05', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(owned ? [ALIAS] : []),
    }),
  )
}

test.beforeEach(async ({ page }) => {
  // The payment watcher opens a WebSocket to `/ws?hash=…`. Playwright can't
  // inject into a real socket, so fake the constructor for it: passthrough
  // for the mock relay's ws://localhost:4699 (inbox traffic), and a scripted
  // socket for the payment URL that pushes { status: "paid" } on open.
  await page.addInitScript(
    ([hash]) => {
      const RealSocket = window.WebSocket
      class FakePaymentSocket extends EventTarget {
        static OPEN = 1
        readyState = 1
        sent: string[] = []
        constructor(url: string | URL) {
          super()
          const raw = String(url)
          if (raw.includes(hash)) {
            setTimeout(() => {
              this.onopen?.(new Event('open'))
              this.onmessage?.(
                new MessageEvent('message', { data: JSON.stringify({ status: 'paid' }) }),
              )
            }, 50)
          } else {
            // Relay traffic (mock relay) — real socket, forward handlers.
            const real = new RealSocket(raw)
            for (const key of ['onopen', 'onmessage', 'onerror', 'onclose'] as const) {
              const forward = (v: unknown) => {
                // @ts-expect-error assignment via index
                this[key] = v
              }
              forward(real[key])
              Object.defineProperty(this, key, {
                set: forward,
                get: () => real[key],
                configurable: true,
              })
            }
            this.close = () => real.close()
            this.send = (d: string) => real.send(d)
          }
        }
        close(): void {}
        send(): void {}
      }
      // @ts-expect-error replacing the page's WebSocket
      window.WebSocket = FakePaymentSocket
    },
    [PAYMENT_HASH],
  )
})

test('sidebar buy row opens the wizard in place and a purchase updates the alias list', async ({
  page,
}) => {
  await stubNip05(page, false)
  // Tier list for the embedded wizard — registered before goto, since the
  // wizard fetches tiers as soon as it mounts at the address step.
  await page.route('**/api/tiers/mail', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'base',
          name: 'Mail',
          description: 'Your encrypted mailbox',
          priceSats: 2100,
          features: ['Encrypted inbox'],
          notIncluded: [],
          available: true,
        },
      ]),
    }),
  )
  // Invoice request is stubbed; the payment watcher gets its "paid" push from
  // the fake socket in beforeEach. NIP-98 signing is real (fresh key).
  await page.route('**/api/generate-invoice/mail', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        invoice: `lnbc2100n1e2e${PAYMENT_HASH.slice(0, 8)}`,
        paymentHash: PAYMENT_HASH,
        amount: 2100,
      }),
    }),
  )

  await page.goto('/mails')
  await createAccount(page)
  await completeOnboarding(page)

  // The sidebar row sits right under the Inboxes section.
  await expect(page.getByRole('button', { name: /buy a new address/i })).toBeVisible()

  await page.getByRole('button', { name: /buy a new address/i }).click()

  // The wizard embeds over the current page (no navigation away) and skips the
  // sign-in step — the mail app's live session carries it to address selection.
  await expect(page.getByRole('heading', { name: /pick your address/i })).toBeVisible()
  await expect(page).toHaveURL(/\/mails$/)

  await page.getByPlaceholder('you').fill('zoe')
  await expect(page.getByText(/zoe@mailstr.app is available/i)).toBeVisible()

  await page.getByRole('button', { name: /get mail .* 2,100/i }).click()
  // The fake socket's "paid" push fires ~50ms after the watcher connects, so
  // the QR step can be skipped before a snapshot catches it — wait on the
  // success step instead.
  await expect(page.getByRole('heading', { name: /you're all set/i })).toBeVisible()

  // "Done" completes the purchase: the modal closes (still on /mails) and the
  // owned-address reload fires with the API now reporting the new alias.
  await stubNip05(page, true)
  await page.getByRole('button', { name: /^done$/i }).click()
  await expect(page.getByRole('heading', { name: /pick your address/i })).toBeHidden()

  // The refreshed list flows into the sidebar: with two addresses the
  // per-alias Inboxes section renders, with "zoe" among them.
  const inboxes = page.locator('nav[aria-label="Inboxes"]')
  await expect(inboxes.getByText(ALIAS)).toBeVisible()
})

test('buying over Settings does not discard its unsaved edits', async ({ page }) => {
  await stubNip05(page, false)
  await page.route('**/api/tiers/mail', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'base',
          name: 'Mail',
          description: '',
          priceSats: 2100,
          features: [],
          notIncluded: [],
          available: true,
        },
      ]),
    }),
  )
  await page.goto('/mails')
  await createAccount(page)
  await completeOnboarding(page)

  // Open Settings → Composing, type a signature (an unsaved edit).
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Composing' }).first().click()
  const signature = page.getByPlaceholder('Sent with Mail by Form*')
  await signature.fill('Kind regards, Zoe')
  await expect(signature).toHaveValue('Kind regards, Zoe')

  // Buy flow opens over the pane (via the Addresses pane's own button — the
  // sidebar is under the Settings backdrop)…
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Addresses' }).click()
  await dialog.getByRole('button', { name: /buy a new address/i }).click()
  await expect(page.getByRole('heading', { name: /pick your address/i })).toBeVisible()
  // …and closing it returns to Settings with the draft intact — a URL route
  // here would have unmounted (and lost) it. The pane shows Addresses (the
  // button that opened the flow); switching back to Composing reveals the
  // still-held edit.
  await page.getByRole('button', { name: 'Close' }).last().click()
  await expect(page.getByRole('heading', { name: /pick your address/i })).toBeHidden()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Composing' }).click()
  await expect(signature).toHaveValue('Kind regards, Zoe')
})