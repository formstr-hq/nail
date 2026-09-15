import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeNip05, peekNip05, clearProbeCache } from './nip05'

afterEach(() => {
  clearProbeCache()
  vi.unstubAllGlobals()
})

describe('peekNip05', () => {
  it('is a pure read: no fetch, null before any probe', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(peekNip05('alice@example.org')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns a fresh cached verdict without re-fetching', async () => {
    const fetchSpy = vi.fn(() => new Response(JSON.stringify({ names: { alice: 'a'.repeat(64) } })))
    vi.stubGlobal('fetch', fetchSpy)
    await probeNip05('alice@example.org')
    expect(peekNip05('alice@example.org')).toEqual({ pubkey: 'a'.repeat(64) })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('caches negatives too, so a repeat render never flashes checking', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ names: {} }))))
    await probeNip05('missing@example.org')
    expect(peekNip05('missing@example.org')).toEqual({ pubkey: null })
  })

  it('treats a known-legacy domain as a synchronous negative', () => {
    expect(peekNip05('anyone@gmail.com')).toEqual({ pubkey: null })
  })
})

describe('probeNip05', () => {
  it('dedups concurrent probes for the same address', async () => {
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(JSON.stringify({ names: { a: 'b'.repeat(64) } }))), 5)
        }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const [x, y] = await Promise.all([
      probeNip05('a@example.org'),
      probeNip05('a@example.org'),
    ])
    expect(x).toBe('b'.repeat(64))
    expect(y).toBe('b'.repeat(64))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // Render-time derivation probes every distinct sender on screen; the bound
  // keeps that (and recipient resolution) from fanning out without limit.
  it('bounds concurrent fetches across distinct addresses', async () => {
    let inFlight = 0
    let peak = 0
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          setTimeout(() => {
            inFlight -= 1
            resolve(new Response(JSON.stringify({ names: {} })))
          }, 5)
        }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await Promise.all(
      Array.from({ length: 12 }, (_, i) => probeNip05(`user${i}@example.org`)),
    )
    expect(fetchSpy).toHaveBeenCalledTimes(12)
    expect(peak).toBeLessThanOrEqual(4)
  })
})
