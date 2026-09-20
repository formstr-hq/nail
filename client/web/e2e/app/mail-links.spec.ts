import { test, expect } from '@playwright/test'
import { finalizeEvent, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, encrypt } from 'nostr-tools/nip44'
import { hexToBytes } from 'nostr-tools/utils'
import { createAccount, completeOnboarding } from './helpers'

/**
 * Links in a mail body must be clickable — in both body shapes:
 *
 *  - HTML mail: the sandboxed iframe gets a parent-side click listener that
 *    routes the click to `openExternal`, because the native WebView has no
 *    popup support for `<base target="_blank">` (see lib/openLink.ts).
 *  - Plaintext mail: rendered in a `<pre>`, so URLs are found with
 *    `splitPlainLinks` (linkifyjs) and become real anchors.
 *
 * The specs assert the click reaches the browser (a popup/new tab), which is
 * exactly the step that was missing before.
 */
const BRIDGE_SK_HEX = '11'.repeat(32)
const BRIDGE_PK = getPublicKey(hexToBytes(BRIDGE_SK_HEX))
const RELAY_URL = 'ws://localhost:4699'
/** A 1x1 PNG — enough for the browser to count the image as loaded. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.beforeEach(async ({ page }) => {
  await page.route('**/.well-known/nostr.json*', (route) => {
    const url = new URL(route.request().url())
    const names = url.searchParams.get('name') === '_smtp' ? { _smtp: BRIDGE_PK } : {}
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ names }) })
  })
})

/** Bridge-sealed mail with a chosen subject and RFC 2822 body bytes. */
function bridgeSealedWrap(recipientPubkey: string, subject: string, bodyLines: string[]) {
  const rumor = {
    kind: 1301,
    pubkey: BRIDGE_PK,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkey]],
    content: [
      'From: Jack <jack@example.org>',
      `To: ${recipientPubkey}@mailstr.app`,
      `Subject: ${subject}`,
      `Message-ID: <${subject.toLowerCase().replace(/\W+/g, '-')}@mailstr.app>`,
      ...bodyLines,
    ].join('\r\n'),
  }
  const rumorWithId = { ...rumor, id: getEventHash(rumor) }
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: rumor.created_at,
      tags: [],
      content: encrypt(JSON.stringify(rumorWithId), getConversationKey(hexToBytes(BRIDGE_SK_HEX), recipientPubkey)),
    },
    hexToBytes(BRIDGE_SK_HEX),
  )
  const ephemeralSk = hexToBytes('22'.repeat(32))
  return finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey], ['k', '1301']],
      content: encrypt(JSON.stringify(seal), getConversationKey(ephemeralSk, recipientPubkey)),
    },
    ephemeralSk,
  )
}

async function publishToMockRelay(event: { id: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('mock relay publish timed out'))
    }, 5000)
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]))
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as unknown[]
      if (msg[0] === 'OK' && msg[1] === event.id) {
        clearTimeout(timer)
        ws.close()
        resolve()
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('mock relay connection failed'))
    }
  })
}

/** Sign in, deliver one message, and open it — returns the recipient pubkey. */
async function deliverAndOpen(
  page: import('@playwright/test').Page,
  subject: string,
  bodyLines: string[],
) {
  await page.goto('/mails')
  await createAccount(page)
  await completeOnboarding(page)

  const recipientPubkey = await page.evaluate(() => {
    const prefix = '@formstr/signer:'
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix) && key.endsWith('active-pubkey')) return localStorage.getItem(key)
    }
    return null
  })
  expect(recipientPubkey).toBeTruthy()

  await publishToMockRelay(bridgeSealedWrap(recipientPubkey!, subject, bodyLines))
  await page.getByText(subject).first().click()
  await expect(page.getByRole('heading', { name: subject })).toBeVisible()
}

test('an HTML mail link opens the browser', async ({ page }) => {
  await deliverAndOpen(page, 'Html links', [
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<p>Hello, visit <a href="https://example.com/hello">example.com</a></p>',
  ])

  const link = page.frameLocator('iframe[title^="Message:"]').getByRole('link', {
    name: 'example.com',
  })
  await expect(link).toBeVisible()

  const popup = page.waitForEvent('popup')
  await link.click()
  expect((await popup).url()).toBe('https://example.com/hello')
})

test('a plaintext mail URL is a clickable link', async ({ page }) => {
  await deliverAndOpen(page, 'Plain text link', [
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Hi, see https://example.org/plain for details.',
  ])

  const link = page.getByRole('link', { name: 'https://example.org/plain' })
  await expect(link).toBeVisible()

  const popup = page.waitForEvent('popup')
  await link.click()
  expect((await popup).url()).toBe('https://example.org/plain')
})

/**
 * The native path, pinned without a device: the app's Capacitor global is
 * faked at click time (after login, so no other native branch is affected) and
 * the click must reach `Browser.open` — a `target="_blank"` popup would not
 * exist in the Android WebView.
 */
test('on native the click is routed through the Browser plugin', async ({ page }) => {
  await deliverAndOpen(page, 'Native link', [
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<p>See <a href="https://example.com/native">this</a></p>',
  ])

  await page.evaluate(() => {
    ;(window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        Browser: {
          open: (options: { url: string }) => {
            ;(window as unknown as { __opened: string[] }).__opened ??= []
            ;(window as unknown as { __opened: string[] }).__opened.push(options.url)
            return Promise.resolve()
          },
        },
      },
    }
  })

  const popupSeen = { value: false }
  page.on('popup', () => {
    popupSeen.value = true
  })

  await page
    .frameLocator('iframe[title^="Message:"]')
    .getByRole('link', { name: 'this' })
    .click()

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
    .toEqual(['https://example.com/native'])
  expect(popupSeen.value).toBe(false)
})

/**
 * Remote images: the notice appears first (no network), and "Load images" must
 * actually fetch them.
 *
 * The regression was mixed content: on a secure origin the WebView blocks
 * `http://` images before the CSP applies, so the button appeared dead. The
 * frame now carries `upgrade-insecure-requests`, so a host that serves the
 * same path over https loads.
 */
test('Load images fetches remote content, including an http URL', async ({ page }) => {
  const fetched: string[] = []
  await page.route('https://images.example.test/**', (route) => {
    fetched.push(route.request().url())
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })

  await deliverAndOpen(page, 'Remote image', [
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<p>Hello</p><img src="http://images.example.test/hero.png" alt="hero">',
  ])

  await expect(page.getByText(/hosted elsewhere/i)).toBeVisible()
  expect(fetched).toEqual([])

  await page.getByRole('button', { name: /load images/i }).click()

  // The upgrade rewrote http -> https, so this is the URL that was fetched.
  await expect.poll(() => fetched, { timeout: 5000 }).toEqual([
    'https://images.example.test/hero.png',
  ])
})
