import { useEffect, useRef, useState } from 'react'
import { renderLoginHtml, attachLoginListeners } from '@formstr/signer/ui'
import '@formstr/signer/styles.css'
import { nostrSigner, getSignerPool } from '@/app/lib/nostr/signer'

import { markFreshSignup } from '@/app/lib/freshSignup'
import { DEFAULT_RELAYS } from '@/app/lib/nostr/constants'
import { useAccountStore } from '@/app/store/account'
import { isNativeApp } from '@/lib/platform'
import {
  tuneLoginUi,
  methodListNav,
  autoGenerateQr,
  removeInapplicableMethod,
  injectAndroidSigners,
  friendlyUnlockError,
  fitOverlayToViewport,
  MAILSTR_GLYPH,
} from '@/lib/loginUi'
import { addCancelAffordance } from './addCancelAffordance'

/**
 * @formstr/signer login modal (NIP-07 / NIP-46 / NIP-49 / NIP-55).
 *
 * Used two ways: as the whole login page (no props), and — with `onCancel` —
 * over the app to add a second account, where a successful `onLogin` also
 * fires `onLoggedIn` so the caller can dismiss the overlay.
 */
export function SignerLogin({
  onLoggedIn,
  onCancel,
}: {
  onLoggedIn?: () => void
  onCancel?: () => void
} = {}) {
  const refresh = useAccountStore((s) => s.refresh)
  const [error, setError] = useState('')
  const loginRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = loginRef.current
    if (!el) return
    // Browser NIP-55 is hidden in the native shell (where the Capacitor
    // `android` tab and injectAndroidSigners take over) and carries a
    // warning on Firefox for Android, which cannot read the clipboard.
    el.innerHTML = renderLoginHtml({
      nip55Web: nostrSigner.nip55WebSupport(),
    })
    tuneLoginUi(el, {
      relays: DEFAULT_RELAYS,
      brand: {
        html:
          MAILSTR_GLYPH +
          '<h2 class="nostr-signer__brand-title">Sign in</h2>' +
          "<p class='nostr-signer__brand-sub'>Choose how you'd like to access your mail</p>",
      },
    })
    const detachCancel = onCancel ? addCancelAffordance(el, onCancel) : undefined
    const binding = attachLoginListeners(el, nostrSigner, {
      pool: getSignerPool(),
      onLogin: () => {
        refresh()
        onLoggedIn?.()
      },
      onCancel,
      onError: (err) => setError(friendlyUnlockError(err)),
    })
    // After the package has wired its listeners, so removing an element can't
    // null out one of its queries (see removeInapplicableMethod).
    removeInapplicableMethod(el)
    const detachSigners = isNativeApp()
      ? injectAndroidSigners(el, nostrSigner, {
          onSuccess: () => {
            refresh()
            onLoggedIn?.()
          },
          onError: setError,
        })
      : () => {}
    const detachQr = autoGenerateQr(el)
    const detachNav = methodListNav(el)
    const detachFit = fitOverlayToViewport(el)
    // A brand-new key created here provably has no kind-10050 relay list, so
    // flag it for the relay onboarding. Capture phase on the container runs
    // before the package's own created-ack handler fires onLogin, so the flag
    // is set by the time onboarding reads it. Only the create path clicks
    // created-ack, so imports/extensions are never marked.
    const markCreated = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest('[data-action="created-ack"]')) {
        const pk = nostrSigner.getActiveAccount()?.pubkey
        if (pk) markFreshSignup(pk)
      }
    }
    el.addEventListener('click', markCreated, true)
    return () => {
      detachSigners()
      detachFit()
      detachNav()
      detachQr()
      detachCancel?.()
      binding.detach()
      el.removeEventListener('click', markCreated, true)
      el.innerHTML = ''
    }
  }, [refresh, onLoggedIn, onCancel])

  return (
    <>
      <div ref={loginRef} />
      {error && <p className="text-center text-sm text-destructive">{error}</p>}
    </>
  )
}
