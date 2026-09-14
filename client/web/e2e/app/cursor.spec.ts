import { test, expect, type Locator } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

/**
 * Regression guard for the Tailwind v3→v4 port: v4's preflight dropped v3's
 * `button { cursor: pointer }` base rule, so every native button in the mail
 * app (folder rows, mail rows, composer chrome, Send) silently lost its hand
 * cursor. The restore lives in src/index.css under `@layer base`
 * (`button:not(:disabled), [role="button"]:not(:disabled)`).
 *
 * Computed style, not screenshots: the bug is invisible to role queries, and
 * Chromium's UA default for a button is `default`, so this fails if the base
 * rule is dropped again.
 */
async function cursorOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).cursor)
}

test('buttons render with a hand cursor; disabled buttons keep not-allowed', async ({ page }) => {
  await page.goto('/mails')
  await createAccount(page)
  await completeOnboarding(page)

  // A native <button> in the sidebar (the same element type as an EmailRow).
  const inboxFolder = page.locator('nav[aria-label="Mail folders"]').getByRole('button', {
    name: /inbox/i,
  })
  await expect(inboxFolder).toBeVisible()
  expect(await cursorOf(inboxFolder)).toBe('pointer')

  // The shared Button component (the filled "Write" hero action).
  const write = page.getByRole('button', { name: /^write$/i })
  expect(await cursorOf(write)).toBe('pointer')

  // A disabled control must not read as clickable: the composer's Send is
  // disabled with no recipient, and `disabled:cursor-not-allowed` still wins.
  await write.click()
  const send = page.getByRole('button', { name: /^send$/i })
  await expect(send).toBeDisabled()
  expect(await cursorOf(send)).toBe('not-allowed')
})
