// Dark-mode mobile screenshots. colorScheme:'dark' makes the landing's
// prefers-color-scheme block and the client's `system`->`.dark` path both paint dark.
import { chromium, devices } from '/Volumes/AppsDrive/Dev/nail/client/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mobile')
const LANDING = 'http://localhost:5178'
const CLIENT = 'http://localhost:5179'

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' })

// Landing hero (dark)
{
  const page = await ctx.newPage()
  await page.goto(LANDING + '/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(outDir, 'landing-hero-dark.png') })
  console.log('saved landing-hero-dark.png')
  await page.close()
}

// Client compose (dark) — drive create -> onboarding -> inbox -> compose
{
  const page = await ctx.newPage()
  await page.goto(CLIENT + '/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: /create a new account/i }).click()
  const createPanel = page.locator('.nostr-signer__panel--create')
  await createPanel.locator('input[name="passphrase"]').fill('shots-pass-phrase')
  await createPanel.getByRole('button', { name: /create account/i }).click()
  const ack = page.locator('[data-action="created-ack"]')
  await ack.waitFor({ state: 'visible', timeout: 15000 })
  await ack.click()
  const confirm = page.getByRole('button', { name: /confirm relays/i })
  await confirm.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
  if (await confirm.count()) {
    await confirm.click()
    await confirm.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
  }
  await page.waitForTimeout(3000)
  await page.screenshot({ path: path.join(outDir, 'client-inbox-dark.png') })
  console.log('saved client-inbox-dark.png')
  const compose = page.getByRole('button', { name: /compose|write|new/i })
  if (await compose.count()) {
    await compose.first().click().catch(() => {})
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(outDir, 'client-compose-dark.png') })
    console.log('saved client-compose-dark.png')
  }
  await page.close()
}

await browser.close()
console.log('done')
