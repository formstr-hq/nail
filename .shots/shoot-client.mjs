// Drive the real create-account -> onboarding -> inbox flow and screenshot the
// mail client in a mobile viewport. Uses a throwaway random key.
import { chromium, devices } from '/Volumes/AppsDrive/Dev/nail/client/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mobile')
const CLIENT = 'http://localhost:5179'

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 13'] })
const page = await ctx.newPage()

await page.goto(CLIENT + '/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)

// create a new account
await page.getByRole('button', { name: /create a new account/i }).click()
const createPanel = page.locator('.nostr-signer__panel--create')
await createPanel.locator('input[name="passphrase"]').fill('shots-pass-phrase')
await createPanel.getByRole('button', { name: /create account/i }).click()

// acknowledge the ncryptsec backup
const ack = page.locator('[data-action="created-ack"]')
await ack.waitFor({ state: 'visible', timeout: 15000 })
await ack.click()

// relay onboarding
const confirm = page.getByRole('button', { name: /confirm relays/i })
await confirm.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
if (await confirm.count()) {
  await confirm.click()
  await confirm.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
}

await page.waitForTimeout(3000)
await page.screenshot({ path: path.join(outDir, 'client-inbox.png') })
console.log('saved client-inbox.png')

// open compose
const compose = page.getByRole('button', { name: /compose|write|new/i })
if (await compose.count()) {
  await compose.first().click().catch(() => {})
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(outDir, 'client-compose.png') })
  console.log('saved client-compose.png')
}

await browser.close()
console.log('done')
