import { afterEach, describe, expect, it, vi } from 'vitest'
import { installAndroidBackHandler } from './androidBack'

/**
 * D12: with a listener installed, Capacitor fires the JS `backButton` event and
 * does NOT fall through when the JS side declines. So at the client root the
 * handler must call exitApp() itself rather than returning false into a void.
 */
function stubNativeApp() {
  let handler: (() => void) | null = null
  const exitApp = vi.fn(async () => {})
  const remove = vi.fn(async () => {})
  vi.stubGlobal('window', {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: {
        App: {
          addListener: async (_event: string, h: () => void) => {
            handler = h
            return { remove }
          },
          removeAllListeners: async () => {},
          exitApp,
        },
      },
    },
  })
  return {
    exitApp,
    remove,
    press: () => handler?.(),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('installAndroidBackHandler', () => {
  it('exits the app when the dispatch callback declines (root of the stack)', async () => {
    const app = stubNativeApp()
    await installAndroidBackHandler(() => false)
    app.press()
    expect(app.exitApp).toHaveBeenCalledTimes(1)
  })

  it('does not exit when the handler consumed the press', async () => {
    const app = stubNativeApp()
    await installAndroidBackHandler(() => true)
    app.press()
    expect(app.exitApp).not.toHaveBeenCalled()
  })

  it('is a no-op on the web (no Capacitor global)', async () => {
    vi.stubGlobal('window', {})
    const dispose = await installAndroidBackHandler(() => false)
    expect(typeof dispose).toBe('function')
  })
})
