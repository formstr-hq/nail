import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { config } from '@/lib/config'
import { getMailTiers, resolveNip05, type MailTier } from '@/lib/api'
import { isValidLocalPart } from '@/lib/nostr'
import { signer } from '@/lib/signer'
import { redirectToMails } from '@/lib/session'
import { NameStep, type Availability } from '@/components/signup/NameStep'
import { UnlockStoredForm } from '@/components/signup/UnlockStoredForm'
import { KeysStep, DoneStep } from '@/components/signup/KeysStep'
import { ResolvingStep } from '@/components/signup/ResolvingStep'
import { useSignupLogin, type Step } from '@/components/signup/useSignupLogin'
import { PaymentSheet } from '@/components/payments/PaymentSheet'
import { useCurrencyPreference } from '@/lib/payments/preferences'
import type { PaymentChoice } from '@/lib/payments/types'

const STORE_BUILD = import.meta.env.VITE_STORE_BUILD === '1'

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
  const [payer, setPayer] = useState<NonNullable<ReturnType<typeof signer.getActiveSigner>> | null>(null)
  const payIn = useCurrencyPreference((s) => s.currency)
  const setPayIn = useCurrencyPreference((s) => s.setCurrency)
  const [payChoice, setPayChoice] = useState<PaymentChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loginRef = useRef<HTMLDivElement>(null)
  // "Use a different key" escape hatch: drops back to the full signer UI.
  const [skipUnlock, setSkipUnlock] = useState(false)
  const [passphrase, setPassphrase] = useState('')

  const { showUnlock, lockedAccount, unlockStored } = useSignupLogin({
    step,
    setStep,
    setPubkey,
    setBusy,
    setError,
    purchaseMode,
    loginRef,
    passphrase,
    skipUnlock,
  })

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

  /* Step 2 → 3 — nothing is ordered yet: the pay step creates the order for
     whichever payment method the buyer picks. We only need a live signer. */
  const goToPay = () => {
    const active = signer.getActiveSigner()
    if (!pubkey || !active) {
      setError('Your session is locked — sign in again.')
      setStep('login')
      return
    }
    if (!selectedTierId) {
      setError('Pick a plan first.')
      return
    }
    setError(null)
    setPayer(active)
    setStep('pay')
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
            payIn={payIn ?? ''}
            onPayInChange={setPayIn}
            onPayInChoiceChange={setPayChoice}
            paymentReady={STORE_BUILD || payChoice !== null}
            onContinue={goToPay}
            onRetryCheck={() => {
              setCheckFailed(null)
              setCheckNonce((n) => n + 1)
            }}
          />
        )}

        {step === 'pay' && pubkey && payer && selectedTierId && (
          <PaymentSheet
            order={{ product: 'mail', pubkey, nip05: `${name}@${config.mailDomain}`, tierId: selectedTierId }}
            signer={payer}
            tier={tiers?.find((t) => t.id === selectedTierId) ?? null}
            choice={STORE_BUILD ? undefined : payChoice}
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
