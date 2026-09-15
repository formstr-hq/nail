import { test, expect } from '@playwright/test'
import { finalizeEvent, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, encrypt } from 'nostr-tools/nip44'
import { hexToBytes } from 'nostr-tools/utils'
import { createAccount, completeOnboarding } from './helpers'

/**
 * The regression behind ADR-005: sender proof must be derived at RENDER time,
 * not frozen when a message is decoded.
 *
 * A bridge-sealed message (the bridge refuses to relay a From the sender's key
 * does not own, §5) must display the claimed `From:` address, not the bridge's
 * npub and "unverified sender". Bridge resolution is a NIP-05 lookup that lands
 * asynchronously, so the message can be decoded and on screen before the
 * bridge's key is known; the proof has to update when it arrives.
 *
 * This drives the real app end to end: a real account signs in, the bridge
 * probe is served by a route stub (resolved `_smtp`), and a genuine gift wrap
 * sealed by that bridge key is delivered through the mock relay.
 */
const BRIDGE_SK_HEX = '11'.repeat(32)
const BRIDGE_PK = getPublicKey(hexToBytes(BRIDGE_SK_HEX))
const RELAY_URL = 'ws://localhost:4699'
const CLAIMED_FROM = 'Jack <jack@example.org>'

test.beforeEach(async ({ page }) => {
  // The `_smtp` record resolves to our deterministic bridge key; every other
  // NIP-05 name (the sender's own address probe) comes back empty.
  await page.route('**/.well-known/nostr.json*', (route) => {
    const url = new URL(route.request().url())
    const names = url.searchParams.get('name') === '_smtp' ? { _smtp: BRIDGE_PK } : {}
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ names }),
    })
  })
})

/** Build a NIP-59 gift wrap sealed by the bridge, addressed to `recipient`. */
function bridgeSealedWrap(recipientPubkey: string) {
  const rumor = {
    kind: 1301,
    pubkey: BRIDGE_PK,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkey]],
    content: [
      `From: ${CLAIMED_FROM}`,
      `To: ${recipientPubkey}@mailstr.app`,
      'Subject: Bridge-sealed hello',
      'Message-ID: <bridge-e2e@mailstr.app>',
      '',
      'This message came through the bridge from legacy email.',
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

/**
 * Publish an event straight to the mock relay from the test process.
 *
 * The app's key is created by the UI during the test, so the wrap cannot be
 * built before the page runs — the recipient pubkey is read from the signer's
 * persisted record (the same place the app reads it) after sign-in.
 */
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

test('bridge-sealed mail shows the claimed From once the bridge key resolves', async ({ page }) => {
  await page.goto('/mails')
  await createAccount(page)
  await completeOnboarding(page)

  // The signed-in account's pubkey, read from the signer's persisted record —
  // exactly where the app itself reads it, so no parallel fixture drifts.
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

  // Open the message and assert the SENDER identity shown is the claimed
  // address — not an npub and not the "unverified sender" line. Before the
  // fix, decode-time proof against a not-yet-resolved bridge froze exactly
  // that wrong verdict. The header renders name and address as separate
  // elements, so match each.
  await page.getByText('Bridge-sealed hello').first().click()
  await expect(page.getByText('jack@example.org').first()).toBeVisible()
  await expect(page.getByText('Jack', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/via email bridge/i).first()).toBeVisible()
  await expect(page.getByText(/unverified sender/i)).toHaveCount(0)
})
