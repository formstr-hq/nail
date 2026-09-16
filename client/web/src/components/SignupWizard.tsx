import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { renderLoginHtml, attachLoginListeners } from '@formstr/signer/ui'
import '@formstr/signer/styles.css'
import { signer, pool, NOSTRCONNECT_RELAYS } from '@/lib/signer'
import { isNativeApp } from '@/lib/platform'
import { config } from '@/lib/config'
import {
  apiUrl,
  generateMailInvoice,
  getMailTiers,
  ownsMailbox,
  resolveNip05,
  type MailInvoice,
  type MailTier,
} from '@/lib/api'
import { isValidLocalPart } from '@/lib/nostr'
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
import InvoiceQR from '@/components/InvoiceQR'
import { NameStep, type Availability } from '@/components/signup/NameStep'
import { UnlockStoredForm } from '@/components/signup/UnlockStoredForm'
import { KeysStep, DoneStep } from '@/components/signup/KeysStep'
import { ResolvingStep } from '@/components/signup/ResolvingStep'

type Step = 'login' | 'resolving' | 'name' | 'pay' | 'keys' | 'done'

interface SignupWizardProps {
  /** Name the user typed in the hero input, if it was a name. */
  initialName?: string
  onClose: () => void
  /**
   * Set when the mail client sends an existing owner here to buy an
   * *additional* address. Skips the "already owns a mailbox → bounce to the
   * inbox" shortcut so a returning owner reaches address selection instead of
   * being redirected straight back where they came from.
   */
  purchaseMode?: boolean
  /**
   * Embedded completion (the mail client's in-app buy modal): replaces the
   * "Open your inbox" redirect with a caller-supplied continuation, so the
   * wizard can close and hand control back to the page that opened it.
   * Absent on the landing, which keeps the redirect behaviour.
   */
  onComplete?: () => void
  /**
   * Embedded mode only: the mail client mounts this wizard with a live,
   * already-resumed session, so step straight to address selection instead of
   * rendering the sign-in picker for the silent resume to immediately replace.
   * If the session turns out to be dead mid-purchase, requestInvoice falls
   * back to the normal login step.
   */
  skipLogin?: boolean
  /** The account pubkey in embedded mode — signs the NIP-98 invoice request. */
  initialPubkey?: string
}

export default function SignupWizard({
  initialName,
  onClose,
  purchaseMode = false,
  onComplete,
  skipLogin = false,
  initialPubkey,
}: SignupWizardProps) {
  const [step, setStep] = useState<Step>(skipLogin ? 'name' : 'login')
  const [pubkey, setPubkey] = useState<string | null>(initialPubkey ?? null)
  const [name, setName] = useState(initialName ?? '')
  const [nameCheck, setNameCheck] = useState<{ name: string; taken: boolean } | null>(null)
  // The name whose availability check failed, plus a nonce the Retry button
  // bumps to re-run it. Without this a flaky lookup leaves the field stuck on
  // "Checking…" forever with "Claim it" permanently disabled — a dead end.
  const [checkFailed, setCheckFailed] = useState<string | null>(null)
  const [checkNonce, setCheckNonce] = useState(0)
  const [tiers, setTiers] = useState<MailTier[] | null>(null)
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null)
  const [invoice, setInvoice] = useState<MailInvoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loginRef = useRef<HTMLDivElement>(null)
  // "Use a different key" escape hatch: drops back to the full signer UI.
  const [skipUnlock, setSkipUnlock] = useState(false)
  const [passphrase, setPassphrase] = useState('')

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
    [purchaseMode],
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
  }, [lockedAccount, passphrase, proceedAs])

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
      // Browser NIP-55 needs an Android browser with clipboard access, and is
      // suppressed in the native shell (removeInapplicableMethod handles the
      // Capacitor `android` tab; this drops the browser counterpart there).
      el.innerHTML = renderLoginHtml({
        includeNip55Web: signer.supportsNip55Web(),
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
  }, [step, proceedAs, showUnlock])

  /* Step 2 — debounced availability check on the chosen name. */
  useEffect(() => {
    if (step !== 'name' || !name || !isValidLocalPart(name)) return
    const t = setTimeout(async () => {
      try {
        const owner = await resolveNip05(name)
        setNameCheck({ name, taken: owner !== null })
        setCheckFailed(null)
      } catch {
        // Surface a retryable inline error instead of a permanent "Checking…".
        setCheckFailed(name)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [step, name, checkNonce])

  const availability: Availability = !name
    ? 'idle'
    : !isValidLocalPart(name)
      ? 'invalid'
      : checkFailed === name
        ? 'error'
        : nameCheck?.name === name
          ? nameCheck.taken
            ? 'taken'
            : 'free'
          : 'checking'

  useEffect(() => {
    if (step !== 'name' || tiers !== null) return
    getMailTiers()
      .then((list) => {
        setTiers(list)
        setSelectedTierId((prev) => prev ?? list.find((t) => t.available)?.id ?? null)
      })
      .catch(() => setTiers(null))
  }, [step, tiers])

  /* Step 2 → 3 — NIP-98-signed invoice request. */
  const requestInvoice = async () => {
    const active = signer.getActiveSigner()
    if (!pubkey || !active) {
      setError('Your session is locked — sign in again.')
      setStep('login')
      return
    }
    const selectedTier = tiers?.find((t) => t.id === selectedTierId) ?? null
    if (!selectedTier) {
      setError('Pick a plan first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      // tierId is part of the signed body, so the backend prices by the chosen
      // tier and the NIP-98 payload digest still matches what's sent.
      const body = {
        pubkey,
        nip05: `${name}@${config.mailDomain}`,
        tierId: selectedTier.id,
      }
      const url = apiUrl('/api/generate-invoice/mail')
      const header = await buildNip98Header(active, url, 'POST', JSON.stringify(body))
      const inv = await generateMailInvoice(header, body)
      setInvoice(inv)
      setStep('pay')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invoice request failed')
    } finally {
      setBusy(false)
    }
  }

  const address = `${name || 'you'}@${config.mailDomain}`

  return (
    <div
      className="safe-modal fixed inset-0 z-[70] flex items-center justify-center bg-ink/60 px-4 backdrop-blur-sm"
      onClick={step === 'pay' ? undefined : onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-black/10 bg-paper p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-ink">
              {step === 'login' && (showUnlock ? 'Unlock your key' : 'Sign in with your Nostr key')}
              {step === 'resolving' && 'One moment…'}
              {step === 'name' && 'Pick your address'}
              {step === 'pay' && "One payment, and it's yours"}
              {step === 'keys' && "You're all set"}
              {step === 'done' && 'Welcome to Mail by Formstr'}
            </h3>
            <p className="mt-0.5 text-sm text-gray-500">
              {step === 'login' &&
                (showUnlock
                  ? 'Your key is stored encrypted on this device — enter its passphrase to continue.'
                  : 'Your key is your account. New to Nostr? Create one below.')}
              {step === 'resolving' && 'Checking your account'}
              {step === 'name' && 'This becomes your email and your NIP-05 handle.'}
              {step === 'pay' && `Claiming ${address}`}
              {step === 'keys' && 'Your address is confirmed and ready.'}
              {step === 'done' && 'Taking you to your inbox…'}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-black/[0.05] hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {step === 'login' &&
          (showUnlock && lockedAccount ? (
            <UnlockStoredForm
              account={lockedAccount}
              passphrase={passphrase}
              busy={busy}
              onPassphraseChange={setPassphrase}
              onSubmit={() => void unlockStored()}
              onUseAnother={() => setSkipUnlock(true)}
            />
          ) : (
            <div ref={loginRef} className="signer-embed" />
          ))}

        {step === 'resolving' && <ResolvingStep />}

        {step === 'name' && (
          <NameStep
            name={name}
            onNameChange={setName}
            availability={availability}
            address={address}
            tiers={tiers}
            selectedTierId={selectedTierId}
            onSelectTier={setSelectedTierId}
            busy={busy}
            onRequestInvoice={requestInvoice}
            onRetryCheck={() => {
              setCheckFailed(null)
              setCheckNonce((n) => n + 1)
            }}
          />
        )}

        {step === 'pay' && invoice && (
          <InvoiceQR
            invoice={invoice.invoice}
            hash={invoice.paymentHash}
            amount={invoice.amount}
            unit={tiers?.find((t) => t.id === selectedTierId)?.unit ?? 'sats'}
            onPaid={() => setStep('keys')}
          />
        )}

        {step === 'keys' && (
          <KeysStep
            address={address}
            embedded={Boolean(onComplete)}
            onDone={() => {
              // Embedded mode hands control straight back — the parent
              // unmounts the wizard, so the "done" step never shows here.
              if (onComplete) onComplete()
              else {
                setStep('done')
                redirectToMails()
              }
            }}
          />
        )}
        {step === 'done' && <DoneStep address={address} />}
      </div>
    </div>
  )
}
