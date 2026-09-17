import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchMailDiscovery,
  sendWrapViaApi,
  clearMailDiscoveryCache,
  mailDiscoveryUrl,
} from './bridgeSend'

// NIP-98 signing is exercised by nip98's own tests; here we only need a header
// and a deterministic signing failure path.
const buildNip98Header = vi.fn<(...a: unknown[]) => Promise<string>>()
vi.mock('@/lib/nip98', () => ({
  buildNip98Header: (...a: unknown[]) => buildNip98Header(...a),
}))

// apiUrl/apiAuthUrl are pure string joins; keep them real but pinned.
vi.mock('@/app/lib/api/config', () => ({
  apiUrl: (p: string) => `https://api.formstr.app${p}`,
  apiAuthUrl: (p: string) => `https://api.formstr.app${p}`,
}))

const DISCOVERY = {
  version: 1,
  bridge_pubkey: 'a'.repeat(64),
  send_wrap_endpoint: 'https://api.formstr.app/api/mails/send-wrap',
  relays: ['wss://relay.primal.net'],
}

const signer = { signEvent: vi.fn() }

beforeEach(() => {
  clearMailDiscoveryCache()
  buildNip98Header.mockReset()
  buildNip98Header.mockResolvedValue('Nostr header')
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchMailDiscovery', () => {
  it('fetches the well-known document and parses the bridge pubkey + endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(DISCOVERY), { status: 200 }),
    )

    const result = await fetchMailDiscovery('mailstr.app')
    expect(result).toEqual({
      bridgePubkey: 'a'.repeat(64),
      sendWrapEndpoint: 'https://api.formstr.app/api/mails/send-wrap',
    })
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(mailDiscoveryUrl('mailstr.app'))
  })

  // The well-known may not be proxied on a deployment yet, but the same
  // document is served by the backend directly; discovery must use it.
  it('falls back to the backend discovery path when the well-known 404s', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(DISCOVERY), { status: 200 }))

    const result = await fetchMailDiscovery('mailstr.app')
    expect(result).not.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://api.formstr.app/api/mails/discovery')
  })

  it('caches a positive answer for the session', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(DISCOVERY), { status: 200 }),
    )
    await fetchMailDiscovery('mailstr.app')
    await fetchMailDiscovery('mailstr.app')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves null (fall back to relay) when no candidate answers', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }))
    expect(await fetchMailDiscovery('mailstr.app')).toBeNull()
  })

  it('resolves null on a malformed document (missing endpoint)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ bridge_pubkey: 'a'.repeat(64) }), { status: 200 }),
    )
    expect(await fetchMailDiscovery('mailstr.app')).toBeNull()
  })

  it('resolves null on a network error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    expect(await fetchMailDiscovery('mailstr.app')).toBeNull()
  })
})

describe('sendWrapViaApi', () => {
  const discovery = {
    bridgePubkey: 'a'.repeat(64),
    sendWrapEndpoint: DISCOVERY.send_wrap_endpoint,
  }
  const wrap = { id: 'w'.repeat(64), kind: 1059 }

  it('POSTs the wrap to the discovered path with the NIP-98 header', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 202 }))

    const result = await sendWrapViaApi({ wrap, discovery, signer })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(202)

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://api.formstr.app/api/mails/send-wrap')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Nostr header' })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ wrap })
    // The body was signed, so the backend's payload-hash check passes.
    expect(buildNip98Header).toHaveBeenCalledWith(
      signer,
      'https://api.formstr.app/api/mails/send-wrap',
      'POST',
      JSON.stringify({ wrap }),
    )
  })

  it('reports a non-2xx with its status and body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Bridge unavailable' }), { status: 502 }),
    )
    const result = await sendWrapViaApi({ wrap, discovery, signer })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(502)
    expect(result.reason).toContain('Bridge unavailable')
  })

  it('treats a signing failure as never-reaching (status 0)', async () => {
    buildNip98Header.mockRejectedValueOnce(new Error('signer refused'))
    const result = await sendWrapViaApi({ wrap, discovery, signer })
    expect(result).toEqual({ ok: false, status: 0, reason: 'signer refused' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects an endpoint that is not a valid URL without fetching', async () => {
    const result = await sendWrapViaApi({
      wrap,
      discovery: { ...discovery, sendWrapEndpoint: 'not-a-url' },
      signer,
    })
    expect(result).toEqual({ ok: false, status: 0, reason: 'invalid send-wrap endpoint' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
