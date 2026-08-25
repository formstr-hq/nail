import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { generateKey, type GeneratedKey } from './openpgp'
import { wkdUrls, lookupByWkd } from './wkd'

describe('wkdUrls', () => {
  it('matches the WKD spec test vector for the hash + advanced/direct layout', async () => {
    // From the WKD draft: Joe.Doe@example.org hashes to this zbase32 digest.
    const urls = await wkdUrls('Joe.Doe@example.org')
    expect(urls[0]).toBe(
      'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
    )
    expect(urls[1]).toBe(
      'https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
    )
  })

  it('lowercases the domain but preserves local-part case in the l= param', async () => {
    const urls = await wkdUrls('Alice@Example.COM')
    expect(urls[0]).toContain('openpgpkey.example.com/.well-known/openpgpkey/example.com/hu/')
    expect(urls[0]).toContain('?l=Alice')
  })

  it('returns nothing for a non-address', async () => {
    expect(await wkdUrls('not-an-address')).toEqual([])
  })
})

describe('lookupByWkd', () => {
  let bob: GeneratedKey
  let bobBinary: Uint8Array
  beforeAll(async () => {
    bob = await generateKey({ name: 'Bob', email: 'bob@proton.me' })
    const openpgp = await import('openpgp')
    const key = await openpgp.readKey({ armoredKey: bob.publicKey })
    bobBinary = key.toPublic().write()
  }, 30_000)

  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  function binaryResponse(status: number, bytes: Uint8Array): Response {
    return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes.buffer } as Response
  }

  it('fetches and re-armors a binary key from the advanced URL', async () => {
    fetchMock.mockResolvedValue(binaryResponse(200, bobBinary))
    const key = await lookupByWkd('bob@proton.me')
    expect(key).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----')
    // Advanced URL is tried first.
    expect(fetchMock.mock.calls[0][0]).toContain('openpgpkey.proton.me')
  })

  it('falls back to the direct URL when advanced 404s', async () => {
    fetchMock
      .mockResolvedValueOnce(binaryResponse(404, new Uint8Array()))
      .mockResolvedValueOnce(binaryResponse(200, bobBinary))
    const key = await lookupByWkd('bob@proton.me')
    expect(key).toContain('PGP PUBLIC KEY')
    expect(fetchMock.mock.calls[1][0]).toContain('https://proton.me/.well-known/openpgpkey/hu/')
  })

  it('returns null when a CORS block throws on every URL — never errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await lookupByWkd('bob@proton.me')).toBeNull()
  })

  it('returns null when the domain publishes no key (all 404)', async () => {
    fetchMock.mockResolvedValue(binaryResponse(404, new Uint8Array()))
    expect(await lookupByWkd('nobody@example.com')).toBeNull()
  })

  it('returns null when the bytes are not a valid key', async () => {
    fetchMock.mockResolvedValue(binaryResponse(200, new TextEncoder().encode('garbage')))
    expect(await lookupByWkd('bob@proton.me')).toBeNull()
  })
})
