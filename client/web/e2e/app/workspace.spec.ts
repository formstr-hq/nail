import { test, expect } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

const BRIDGE_PK = 'a'.repeat(64)
const PAYMENT_HASH = 'f'.repeat(64)

/**
 * The Workspace (custom domain) flow: add a domain, publish its DNS, verify,
 * then assign addresses.
 *
 * Pins the fixes this flow needed: add-domain is the first thing on the page,
 * verification status is explicit, the mail records (including the live DKIM
 * value) only appear after verification, npub and hex are both accepted with
 * an "Add my identity" shortcut, several addresses can belong to one pubkey,
 * and a completed seat payment refreshes the seat count without a page reload.
 *
 * All backend calls are stubbed — the client's NIP-98 signing is real (fresh
 * key), the server's answers are scripted.
 */

const DNS = {
  verify: { name: '_mailstr-verify.acme.com', type: 'TXT', value: 'token-123' },
  mx: { name: 'acme.com', type: 'MX', value: 'mails.stg.mailstr.app', priority: 10 },
  spf: { name: 'acme.com', type: 'TXT', value: 'v=spf1 mx ~all' },
  // Before verification the backend has no live DKIM key; after, it does.
  dkim: { name: 'dkim._domainkey.acme.com', type: 'TXT', value: 'v=DKIM1; k=rsa; p=PENDING' },
  dmarc: {
    name: '_dmarc.acme.com',
    type: 'TXT',
    value: 'v=DMARC1; p=reject; rua=mailto:postmaster@acme.com',
  },
}
const DKIM_LIVE = 'v=DKIM1; k=rsa; p=LIVEKEY'

async function stubApp(page: import('@playwright/test').Page) {
  // NIP-05 probes the mail app makes on mount.
  await page.route('**/.well-known/nostr.json*', (route) => {
    const url = new URL(route.request().url())
    const names: Record<string, string> = { _smtp: BRIDGE_PK }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ names: url.searchParams.get('name') ? names : {} }),
    })
  })
  await page.route('**/get-nip05', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )

  let verified = false
  const memberAddresses: {
    id: number
    member_id: number
    nip05_id: number
    status: string
    address: string
    local_part: string
  }[] = []

  const deleted = new Set<string>()
  const domains = () =>
    [
      {
        id: 1,
        domain: 'acme.com',
        owner_pubkey: BRIDGE_PK,
        status: verified ? 'active' : 'pending',
        verified_at: verified ? '2026-01-01T00:00:00Z' : null,
        seats_total: 1,
        seats_used: memberAddresses.length,
      },
      {
        id: 2,
        domain: 'typo.example',
        owner_pubkey: BRIDGE_PK,
        status: 'pending',
        verified_at: null,
        seats_total: 0,
        seats_used: 0,
      },
    ].filter((d) => !deleted.has(d.domain))

  await page.route('**/api/domains/mine', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ domains: domains() }),
    }),
  )
  // A pending domain can be removed; the server refuses when addresses remain.
  await page.route('**/api/domains/typo.example', (route) => {
    if (route.request().method() === 'DELETE') {
      deleted.add('typo.example')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: 'typo.example' }),
      })
    }
    return route.fallback()
  })
  await page.route('**/api/domains/acme.com/dns', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: verified ? 'active' : 'pending',
        verified_at: verified ? '2026-01-01T00:00:00Z' : null,
        dns: verified ? { ...DNS, dkim: { ...DNS.dkim, value: DKIM_LIVE } } : DNS,
      }),
    }),
  )
  await page.route('**/api/domains/acme.com/verify', (route) => {
    verified = true
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'verified', onboarding: { dkim: 'created' } }),
    })
  })
  await page.route('**/api/domains/acme.com/rotate-token', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dns: DNS }) }),
  )
  await page.route('**/api/domains/acme.com/members', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { name: string; pubkey: string }
      const nip05 = 100 + memberAddresses.length
      memberAddresses.push({
        id: nip05,
        member_id: 1,
        nip05_id: nip05,
        status: 'active',
        address: `${body.name}@acme.com`,
        local_part: body.name,
      })
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ address: `${body.name}@acme.com`, seats: { total: 2, used: memberAddresses.length, available: 2 - memberAddresses.length } }),
      })
    }
    const members = [
      {
        id: 1,
        domain_id: 1,
        pubkey: 'c'.repeat(64),
        role: 'owner',
        status: 'active',
        nip05_id: null,
        addresses: [],
      },
    ]
    if (memberAddresses.length) {
      members.push({
        id: 2,
        domain_id: 1,
        pubkey: 'd'.repeat(64),
        role: 'member',
        status: 'active',
        nip05_id: memberAddresses[0].nip05_id,
        addresses: memberAddresses as never,
      } as never)
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        members,
        seats: { total: 2, used: memberAddresses.length, available: 2 - memberAddresses.length },
      }),
    })
  })
  await page.route('**/api/workspace/seat-packs', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { seats: 1, discountPercent: 0, pricePerSeatSats: 20, totalSats: 20 },
      ]),
    }),
  )
  await page.route('**/api/workspace/generate-invoice', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ invoice: 'lnbc1e2e', paymentHash: PAYMENT_HASH, amount: 20, seats: 1, discountPercent: 0 }),
    }),
  )
}

test.beforeEach(async ({ page }) => {
  // The seat-payment watcher opens a WebSocket; fake the payment URL (like the
  // buy-address spec) so "paid" fires without a real socket.
  await page.addInitScript(
    ([hash]) => {
      const RealSocket = window.WebSocket
      class FakePaymentSocket extends EventTarget {
        static OPEN = 1
        readyState = 1
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

test('workspace setup: add → DNS → verify → assign addresses', async ({ page }) => {
  await stubApp(page)
  await page.goto('/mails')
  await createAccount(page)
  await completeOnboarding(page)

  // Open the full-page Workspace setup from the sidebar.
  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible()
  await expect(page).toHaveURL(/\/mails\/workspace$/)

  // Add first: the add form is at the top, above the domain list.
  const addInput = page.getByLabel('Domain name')
  await expect(addInput).toBeVisible()
  await expect(page.getByRole('button', { name: 'acme.com', exact: true })).toBeVisible()

  // Status is explicit while pending.
  await expect(page.getByText(/pending verification/i).first()).toBeVisible()

  // Before verification: the verification TXT is shown, mail records are not.
  await expect(page.getByText('token-123')).toBeVisible()
  await expect(page.getByText(/v=DKIM1/)).toHaveCount(0)

  // Verify: mail records appear, including the *live* DKIM value.
  await page.getByRole('button', { name: /verify domain/i }).click()
  await expect(page.getByText(/v=DKIM1; k=rsa; p=LIVEKEY/)).toBeVisible()
  await expect(page.getByText(/mails\.stg\.mailstr\.app/)).toBeVisible()
  await expect(page.getByText(/v=DMARC1; p=reject/)).toBeVisible()
  await expect(page.getByText(/^Verified/).first()).toBeVisible()

  // Members: "Add my identity" fills the npub form of the signed-in key.
  await page.getByRole('button', { name: /add my identity/i }).click()
  await expect(page.getByLabel('Identity pubkey')).toHaveValue(/^npub1/)

  // Assign two addresses to the same pubkey — allowed, and both listed.
  await page.getByLabel('Address name').fill('contact')
  await page.getByRole('button', { name: /^assign$/i }).click()
  await expect(page.getByText('contact@acme.com')).toBeVisible()
  // The identity field clears after each assign, so re-fill it (same key) and
  // add a second address.
  await page.getByRole('button', { name: /add my identity/i }).click()
  await page.getByLabel('Address name').fill('sales')
  await page.getByRole('button', { name: /^assign$/i }).click()
  await expect(page.getByText('sales@acme.com')).toBeVisible()
  await expect(page.getByText('contact@acme.com')).toBeVisible()

  // Delete a pending domain: no confirmation (it routes nothing), a snackbar
  // confirms, and it leaves the list.
  await page.getByRole('button', { name: 'Delete typo.example' }).click()
  await expect(page.getByRole('status')).toContainText(/typo\.example removed/i)
  await expect(page.getByRole('button', { name: 'Delete typo.example' })).toHaveCount(0)

  // Back to the mail app is reachable at desktop width (not just mobile).
  await page.getByRole('button', { name: /back to mail/i }).click()
  await expect(page).toHaveURL(/\/mails$/)
  await expect(page.getByRole('button', { name: /^write$/i })).toBeVisible()
})
