import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { generateKey, type GeneratedKey } from './openpgp'
import { lookupByEmail, uploadKey, publishKey } from './keyserver'

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
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
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

describe('uploadKey', () => {
  it('POSTs keytext as JSON and parses the token + status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        key_fpr: bob.fingerprint,
        token: 'tok123',
        status: { 'bob@gmail.com': 'unpublished' },
      }),
    )
    const result = await uploadKey(bob.publicKey)
    expect(result).toEqual({
      keyFingerprint: bob.fingerprint,
      token: 'tok123',
      status: { 'bob@gmail.com': 'unpublished' },
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/vks/v1/upload')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ keytext: bob.publicKey })
  })

  it('throws on a non-2xx upload', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}))
    await expect(uploadKey(bob.publicKey)).rejects.toThrow(/upload failed/i)
  })
})

describe('publishKey', () => {
  it('uploads then requests verification for the addresses', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { key_fpr: bob.fingerprint, token: 'tok', status: {} }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          key_fpr: bob.fingerprint,
          token: 'tok',
          status: { 'bob@gmail.com': 'pending' },
        }),
      )

    const result = await publishKey(bob.publicKey, ['bob@gmail.com'])
    expect(result.status['bob@gmail.com']).toBe('pending')
    expect(fetchMock.mock.calls[0][0]).toContain('/vks/v1/upload')
    expect(fetchMock.mock.calls[1][0]).toContain('/vks/v1/request-verify')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      token: 'tok',
      addresses: ['bob@gmail.com'],
    })
  })

  it('skips verification when there are no addresses', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { key_fpr: bob.fingerprint, token: 'tok', status: {} }),
    )
    await publishKey(bob.publicKey, [])
    expect(fetchMock).toHaveBeenCalledTimes(1) // upload only
  })
})
