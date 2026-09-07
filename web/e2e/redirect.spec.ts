import { test, expect } from '@playwright/test'

/**
 * The landing auto-redirects a returning user who already owns a mailbox
 * straight to the inbox (see lib/session.ts + App). These specs guard the two
 * ways that must NOT misfire — the failure the client's "Buy a new address"
 * deep link depends on:
 *
 *  1. A fresh, signed-out visitor is never redirected away from the hero.
 *  2. A `?buy=1` visit is never bounced to the inbox — it opens the signup
 *     wizard so an existing owner can claim an additional address.
 *
 * The positive case (an owner *is* redirected) isn't covered here: it needs a
 * silently-resumable signer session, which can't be faked without a real key,
 * and a redirect in dev only lands on a 404 `/mails`. The unit of logic is
 * small and self-contained in lib/session.ts.
 */

test('a signed-out visitor stays on the landing page', async ({ page }) => {
  await page.goto('/')

  // The hero is up…
  await expect(
    page.getByRole('heading', { name: /email locked to/i }),
  ).toBeVisible()

  // …and stays up: give the mount-time redirect check (bounded ~6s) time to
  // run, then assert we never navigated to the inbox.
  await page.waitForTimeout(1500)
  await expect(page).toHaveURL(/\/$/)
  await expect(
    page.getByRole('heading', { name: /email locked to/i }),
  ).toBeVisible()
})

test('a ?buy=1 deep link opens the signup wizard instead of redirecting', async ({
  page,
}) => {
  await page.goto('/?buy=1')

  // The wizard opens on its sign-in step rather than the page bouncing away.
  await expect(
    page.getByRole('heading', { name: /sign in with your nostr key/i }),
  ).toBeVisible()
  await expect(page).toHaveURL(/buy=1/)
})
