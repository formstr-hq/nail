import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { generateKey, type GeneratedKey } from './openpgp'
import { lookupByEmail } from './keyserver'

let bob: GeneratedKey
beforeAll(async () => {
  bob = await generateKey({ name: 'Bob', email: 'bob@gmail.com' })
}, 30_000)

// A controllable fetch: each test sets what the keyserver "returns".
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function textResponse(status: number, body: string): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as Response
}

describe('lookupByEmail', () => {
  it('returns the armored key when the keyserver has a verified one', async () => {
    fetchMock.mockResolvedValue(textResponse(200, bob.publicKey))
    const key = await lookupByEmail('bob@gmail.com')
    expect(key).toBe(bob.publicKey)
    // Address is lowercased and URI-encoded into the by-email path.
    expect(fetchMock.mock.calls[0][0]).toContain('/vks/v1/by-email/bob%40gmail.com')
  })

  it('returns null on 404 (no verified key — the routine case)', async () => {
    fetchMock.mockResolvedValue(textResponse(404, 'not found'))
    expect(await lookupByEmail('nobody@nowhere.com')).toBeNull()
  })

  it('returns null on rate-limit / server error rather than throwing', async () => {
    fetchMock.mockResolvedValue(textResponse(429, 'slow down'))
    expect(await lookupByEmail('bob@gmail.com')).toBeNull()
  })

  it('returns null when the network is down — never blocks the caller', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(await lookupByEmail('bob@gmail.com')).toBeNull()
  })

  it('rejects a malformed body that isn’t actually a key', async () => {
    fetchMock.mockResolvedValue(textResponse(200, 'HTTP junk, not a key'))
    expect(await lookupByEmail('bob@gmail.com')).toBeNull()
  })
})
