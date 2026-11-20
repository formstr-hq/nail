/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@/app/components/test-utils'
import { SignerLogin } from './SignerLogin'

const signerUi = vi.hoisted(() => ({
  refresh: vi.fn(),
  renderLoginHtml: vi.fn(
    () =>
      '<div class="nostr-signer__modal"><input data-testid="signer-field" /></div>',
  ),
  attachLoginListeners: vi.fn(),
  options: null as null | {
    onLogin: () => void
    onCancel?: () => void
  },
}))

vi.mock('@formstr/signer/ui', () => ({
  renderLoginHtml: signerUi.renderLoginHtml,
  attachLoginListeners: (
    _el: HTMLElement,
    _signer: unknown,
    options: { onLogin: () => void; onCancel?: () => void },
  ) => {
    signerUi.options = options
    return { detach: vi.fn() }
  },
}))

vi.mock('@/app/store/account', () => ({
  useAccountStore: (selector: (s: { refresh: () => void }) => unknown) =>
    selector({ refresh: signerUi.refresh }),
}))

vi.mock('@/app/lib/nostr/signer', () => ({
  nostrSigner: {
    nip55WebSupport: () => false,
    getActiveAccount: () => null,
  },
  getSignerPool: () => ({}),
}))

vi.mock('@/lib/platform', () => ({ isNativeApp: () => false }))

vi.mock('@/lib/loginUi', () => ({
  tuneLoginUi: vi.fn(),
  methodListNav: vi.fn(() => vi.fn()),
  autoGenerateQr: vi.fn(() => vi.fn()),
  removeInapplicableMethod: vi.fn(),
  injectAndroidSigners: vi.fn(() => vi.fn()),
  friendlyUnlockError: (error: unknown) => String(error),
  fitOverlayToViewport: vi.fn(() => vi.fn()),
  MAILSTR_GLYPH: '',
}))

vi.mock('./addCancelAffordance', () => ({
  addCancelAffordance: vi.fn(() => vi.fn()),
}))

beforeEach(() => {
  vi.clearAllMocks()
  signerUi.options = null
})

describe('SignerLogin', () => {
  it('does not rebuild the signer DOM when callback identities change', () => {
    const { rerender } = render(
      <SignerLogin onLoggedIn={vi.fn()} onCancel={vi.fn()} />,
    )
    const field = screen.getByTestId('signer-field')
    expect(signerUi.renderLoginHtml).toHaveBeenCalledTimes(1)

    // Simulate MailApp re-rendering under the add-account overlay: the inline
    // callback props are new functions, but the modal must survive.
    rerender(<SignerLogin onLoggedIn={vi.fn()} onCancel={vi.fn()} />)

    expect(signerUi.renderLoginHtml).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('signer-field')).toBe(field)
  })

  it('calls the latest onLoggedIn after a callback change', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(
      <SignerLogin onLoggedIn={first} onCancel={vi.fn()} />,
    )

    signerUi.options?.onLogin()
    expect(first).toHaveBeenCalledTimes(1)

    rerender(<SignerLogin onLoggedIn={second} onCancel={vi.fn()} />)
    signerUi.options?.onLogin()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
