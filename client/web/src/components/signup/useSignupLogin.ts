import { useCallback, useEffect, useMemo, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { renderLoginHtml, attachLoginListeners } from '@formstr/signer/ui'
import '@formstr/signer/styles.css'
import { signer, pool, NOSTRCONNECT_RELAYS } from '@/lib/signer'
import { isNativeApp } from '@/lib/platform'
import { apiUrl, ownsMailbox } from '@/lib/api'
import { buildNip98Header } from '@/lib/nip98'
import { redirectToMails, unlockWithTimeout } from '@/lib/session'
import { markFreshSignup } from '@/app/lib/freshSignup'
import {
  tuneLoginUi,
  methodListNav,
  autoGenerateQr,
  removeInapplicableMethod,
  injectAndroidSigners,
  friendlyUnlockError,
} from '@/lib/loginUi'

export type Step = 'login' | 'resolving' | 'name' | 'pay' | 'keys' | 'done'

interface UseSignupLoginArgs {
  step: Step
  setStep: Dispatch<SetStateAction<Step>>
  setPubkey: Dispatch<SetStateAction<string | null>>
  setBusy: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
  purchaseMode: boolean
  loginRef: RefObject<HTMLDivElement | null>
  passphrase: string
  skipUnlock: boolean
}

/**
 * Step 1 of the wizard — signing in. Silent resume when a previous session
 * exists, otherwise the @formstr/signer login UI (NIP-07/46/49/55), plus the
 * focused passphrase unlock for a stored ncryptsec key in purchase mode.
 */
export function useSignupLogin({
  step,
  setStep,
  setPubkey,
  setBusy,
  setError,
  purchaseMode,
  loginRef,
  passphrase,
  skipUnlock,
}: UseSignupLoginArgs) {
  const proceedAs = useCallback(
    async (pk: string) => {
      setPubkey(pk)
      // A returning paying user shouldn't be asked to pick an address again — if
      // they already own a mailbox, send them straight to the app. Bounded so a
      // slow signer/lookup can't strand them: any error or timeout falls through
      // to the normal signup. Skipped in purchaseMode, where an existing owner
      // has come here deliberately to claim another address.
      const active = signer.getActiveSigner()
      if (!purchaseMode && active) {
        setStep('resolving')
        try {
          const owns = await Promise.race([
            (async () => {
              const header = await buildNip98Header(active, apiUrl('/api/nip-05/get-nip05'), 'GET')
              return ownsMailbox(header)
            })(),
            new Promise<boolean>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 6000),
            ),
          ])
          if (owns) {
            redirectToMails()
            return
          }
        } catch {
          // fall through to signup
        }
      }
      setStep('name')
    },
    [purchaseMode, setPubkey, setStep],
  )

  /**
   * An ncryptsec key is encrypted at rest, so the silent resume below always
   * fails for it and this tab (a fresh window with no in-memory key) can't sign
   * — which is why buying an address used to demand a full sign-in despite the
   * account already being known here. In purchase mode we know exactly which
   * account to use, so instead of the generic "sign in" UI offer a focused
   * passphrase unlock: it decrypts the stored ncryptsec in place, without the
   * returning-owner redirect or the method picker.
   */
  const lockedAccount = useMemo(() => {
    if (!purchaseMode) return null
    try {
      const account = signer.getActiveAccount()
      if (account?.method === 'ncryptsec' && account.ncryptsec) return account
    } catch {
      // no persisted account visible — fall through to the normal flow
    }
    return null
  }, [purchaseMode])
  const showUnlock = !!lockedAccount && !skipUnlock

  /** Decrypt the stored ncryptsec with the passphrase and continue the purchase. */
  const unlockStored = useCallback(async () => {
    if (!lockedAccount?.ncryptsec || !passphrase) return
    setBusy(true)
    setError(null)
    try {
      await signer.loginWithNcryptsec(lockedAccount.ncryptsec, passphrase)
      await proceedAs(lockedAccount.pubkey)
    } catch (e) {
      setError(friendlyUnlockError(e))
    } finally {
      setBusy(false)
    }
  }, [lockedAccount, passphrase, proceedAs, setBusy, setError])

  /* Step 1 — sign in. Silent resume when a previous session exists, otherwise
     the @formstr/signer login UI (NIP-07/46/49/55). Skipped while the focused
     ncryptsec passphrase unlock is showing — it replaces this. */
  useEffect(() => {
    if (step !== 'login' || showUnlock) return
    let cancelled = false
    let detach: (() => void) | undefined

    void (async () => {
      try {
        const resumed = await unlockWithTimeout()
        if (cancelled) return
        if (resumed) {
          const account = signer.getActiveAccount()
          if (account) {
            await proceedAs(account.pubkey)
            return
          }
        }
      } catch {
        // fall through to the login UI
      }
      const el = loginRef.current
      if (!el || cancelled) return
      // Browser NIP-55 is hidden in the native shell (removeInapplicableMethod
      // handles the Capacitor `android` tab; this drops the browser
      // counterpart there) and warns on Firefox for Android.
      el.innerHTML = renderLoginHtml({
        nip55Web: signer.nip55WebSupport(),
      })
      // The wizard card supplies its own heading, so no brand header here.
      tuneLoginUi(el, { relays: NOSTRCONNECT_RELAYS })
      const binding = attachLoginListeners(el, signer, {
        pool,
        onLogin: () => {
          const account = signer.getActiveAccount()
          if (account) void proceedAs(account.pubkey)
        },
        onError: (err: unknown) => setError(friendlyUnlockError(err)),
      })
      // After attach (so removing an element can't null a package query), then
      // surface installed NIP-55 signers upfront on native.
      removeInapplicableMethod(el)
      const detachSigners = isNativeApp()
        ? injectAndroidSigners(el, signer, {
            onSuccess: () => {
              const account = signer.getActiveAccount()
              if (account) void proceedAs(account.pubkey)
            },
            onError: setError,
          })
        : () => {}
      const detachQr = autoGenerateQr(el)
      const detachNav = methodListNav(el)
      // Flag a freshly-created key for the mail app's relay onboarding. Capture
      // phase on the container runs before the package's created-ack handler
      // fires onLogin, so the flag is set before the redirect. Only the create
      // path clicks created-ack, so imported keys are never marked.
      const markCreated = (e: Event) => {
        if ((e.target as HTMLElement | null)?.closest('[data-action="created-ack"]')) {
          const pk = signer.getActiveAccount()?.pubkey
          if (pk) markFreshSignup(pk)
        }
      }
      el.addEventListener('click', markCreated, true)
      detach = () => {
        detachSigners()
        detachNav()
        detachQr()
        el.removeEventListener('click', markCreated, true)
        binding.detach()
      }
    })()

    return () => {
      cancelled = true
      detach?.()
    }
  }, [step, proceedAs, showUnlock, loginRef, setError])

  return { showUnlock, lockedAccount, unlockStored }
}
