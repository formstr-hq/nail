// Mobile-view screenshots for the Zapstore listing.
// Run with the client's playwright: `node .shots/shoot-mobile.mjs`
import { chromium, devices } from '/Volumes/AppsDrive/Dev/nail/client/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const outDir = path.dirname(fileURLToPath(import.meta.url))
const iphone = devices['iPhone 13']

const LANDING = 'http://localhost:5178'
const CLIENT = 'http://localhost:5179'

async function shoot(ctx, url, file, prep) {
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(1200)
  if (prep) await prep(page)
  await page.screenshot({ path: path.join(outDir, 'mobile', file) })
  console.log('saved', file)
  await page.close()
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...iphone })

// Landing — hero
await shoot(ctx, LANDING + '/', 'landing-hero.png')

// Landing — signup / pick-your-address modal (buy=1 opens it)
await shoot(ctx, LANDING + '/?buy=1', 'landing-signup.png', async (page) => {
  await page.waitForTimeout(1500)
})

// Client — sign-in / method picker (first load)
await shoot(ctx, CLIENT + '/', 'client-login.png')

// Client — create a new account flow
await shoot(ctx, CLIENT + '/', 'client-create.png', async (page) => {
  const btn = page.getByRole('button', { name: /create a new account/i })
  if (await btn.count()) {
    await btn.first().click().catch(() => {})
    await page.waitForTimeout(1500)
  }
})

await browser.close()
console.log('done')
