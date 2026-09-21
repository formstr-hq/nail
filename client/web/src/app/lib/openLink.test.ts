import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSafeExternalUrl, openExternal } from './openLink'

function stubNative(browser: { open: (o: { url: string }) => Promise<void> } | undefined) {
  vi.stubGlobal('window', {
    Capacitor: { isNativePlatform: () => true, Plugins: browser ? { Browser: browser } : {} },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isSafeExternalUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isSafeExternalUrl('https://example.com/a')).toBe(true)
    expect(isSafeExternalUrl('http://example.com/a')).toBe(true)
  })

  it('rejects non-http schemes and relative/invalid input', () => {
    expect(isSafeExternalUrl('mailto:a@b.com')).toBe(false)
    expect(isSafeExternalUrl('tel:+123')).toBe(false)
    expect(isSafeExternalUrl('intent://evil#Intent;end')).toBe(false)
    expect(isSafeExternalUrl('/relative')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })
})

describe('openExternal', () => {
  it('opens via the native Browser plugin and claims the click on native', () => {
    const open = vi.fn().mockResolvedValue(undefined)
    stubNative({ open })

    expect(openExternal('https://example.com/x')).toBe(true)
    expect(open).toHaveBeenCalledWith({ url: 'https://example.com/x' })
  })

  it('declines on the web so the browser opens its own tab', () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => false } })
    expect(openExternal('https://example.com/x')).toBe(false)
  })

  it('declines when the native Browser plugin is unavailable', () => {
    stubNative(undefined)
    expect(openExternal('https://example.com/x')).toBe(false)
  })

  it('declines a dangerous scheme before reaching the plugin', () => {
    const open = vi.fn().mockResolvedValue(undefined)
    stubNative({ open })

    expect(openExternal('intent://evil#Intent;end')).toBe(false)
    expect(openExternal('mailto:a@b.com')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
