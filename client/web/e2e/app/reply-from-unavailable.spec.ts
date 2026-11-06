import { test, expect } from '@playwright/test'
import { finalizeEvent, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, encrypt } from 'nostr-tools/nip44'
import { hexToBytes } from 'nostr-tools/utils'
import { createAccount, completeOnboarding } from './helpers'

/**
 * A reply must never silently switch to a different alias. When the mailbox
 * the original was delivered to is not one this account can send from, the
 * composer starts with no From, explains why, and keeps Send disabled until
 * the user picks one explicitly.
 */
const BRIDGE_SK_HEX = '11'.repeat(32)
const BRIDGE_PK = getPublicKey(hexToBytes(BRIDGE_SK_HEX))
const RELAY_URL = 'ws://localhost:4699'
const ALIAS = 'alice@mailstr.app'
/** Deliberately not one of the account's addresses. */
const NOT_MINE = 'someone-else@mailstr.app'

test.beforeEach(async ({ page }) => {
  await page.route('**/.well-known/nostr.json*', (route) => {
    const url = new URL(route.request().url())
    const names = url.searchParams.get('name') === '_smtp' ? { _smtp: BRIDGE_PK } : {}
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ names }),
    })
  })
  // The account owns exactly one alias; the message's To is not it.
  await page.route('**/get-nip05', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([ALIAS]),
    }),
  )
})

/** Build a NIP-59 gift wrap sealed by the bridge, addressed to `recipient`. */
function bridgeSealedWrap(recipientPubkey: string) {
  const rumor = {
    kind: 1301,
    pubkey: BRIDGE_PK,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkey]],
    content: [
      'From: Jack <jack@example.org>',
      `To: ${NOT_MINE}`,
      'Subject: Not addressed to me',
      'Message-ID: <reply-from-e2e@mailstr.app>',
      '',
      'This message was delivered to a mailbox this account does not own.',
    ].join('\r\n'),
  }
  const rumorWithId = { ...rumor, id: getEventHash(rumor) }
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: rumor.created_at,
      tags: [],
      content: encrypt(
        JSON.stringify(rumorWithId),
        getConversationKey(hexToBytes(BRIDGE_SK_HEX), recipientPubkey),
      ),
    },
    hexToBytes(BRIDGE_SK_HEX),
  )
  const ephemeralSk = hexToBytes('22'.repeat(32))
  return finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey], ['k', '1301']],
      content: encrypt(
        JSON.stringify(seal),
        getConversationKey(ephemeralSk, recipientPubkey),
      ),
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

test('a reply to an unowned mailbox forces an explicit From', async ({ page }) => {
  await page.goto('/mails')
  await createAccount(page)
  await completeOnboarding(page)

  // Wait for the owned alias to reach the app: the picker needs it as the
  // eventual manual choice.
  await expect(page.locator('aside').getByRole('button', { name: ALIAS })).toBeVisible()

  const recipientPubkey = await page.evaluate(() => {
    const prefix = '@formstr/signer:'
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix) && key.endsWith('active-pubkey')) {
        return localStorage.getItem(key)
      }
    }
    return null
  })
  expect(recipientPubkey).toBeTruthy()

  await publishToMockRelay(bridgeSealedWrap(recipientPubkey!))
  await page.getByText('Not addressed to me').first().click()
  await page.getByRole('button', { name: /^reply$/i }).click()

  const fromSelect = page.locator('select')
  await expect(fromSelect).toBeVisible()
  // No default From is chosen; the placeholder is explicit.
  await expect(fromSelect).toHaveValue('')
  await expect(fromSelect.locator('option[value=""]')).toHaveText('Choose a sending address')
  await expect(page.getByText(/wasn.t delivered to one of your addresses/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /^send$/i })).toBeDisabled()

  // An explicit manual choice clears the warning and permits Send.
  await fromSelect.selectOption(ALIAS)
  await expect(fromSelect).toHaveValue(ALIAS)
  await expect(page.getByText(/wasn.t delivered to one of your addresses/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^send$/i })).toBeEnabled()
})
