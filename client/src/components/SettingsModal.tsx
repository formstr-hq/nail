import { useEffect, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { useThemeStore, type ThemePreference } from '@/store/theme'
import { useOwnedAddresses } from '@/hooks/useOwnedAddresses'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'
import { Button, IconButton } from '@/components/ui/Button'
import { XIcon, AlertIcon } from '@/components/ui/icons'

// Sentinel select value for "type your own address" — kept distinct from any
// real address string so it can never collide with an owned/bridge option.
const CUSTOM_SENDER = '__custom__'

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

interface SettingsModalProps {
  onClose: () => void
}

/** A labelled block with a one-line explanation. Used for every setting. */
function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="eyebrow">{label}</div>
      {hint && <p className="text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}

const inputClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] text-foreground placeholder:text-subtle focus:outline-none'

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { account, active } = useAccountStore()
  const { settings, save } = useSettingsStore()
  const { preference, setPreference } = useThemeStore()
  const {
    addresses,
    loading: addressesLoading,
    error: addressesError,
    reload: reloadAddresses,
  } = useOwnedAddresses()

  // Every account has a working inbound bridge address derived from its
  // npub — always offered as an option regardless of purchased names.
  const bridgeAddress = account ? `${account.npub}@${BRIDGE_DOMAIN}` : ''
  const fixedSenderOptions = bridgeAddress ? [...addresses, bridgeAddress] : addresses

  const initialSenderAddress = settings.senderAddress ?? ''
  const [senderAddress, setSenderAddress] = useState(initialSenderAddress)
  // Tracks which <select> option is active: a fixed option's own value, or
  // CUSTOM_SENDER when the free-text input is in play. Derived from the
  // saved value each render (which in practice doesn't change while this
  // modal is open) — if that value isn't one of the fixed options (own
  // addresses may still be loading), it falls into Custom rather than being
  // reset, per the "never regress a saved address" invariant.
  const [senderMode, setSenderMode] = useState<string>(() =>
    fixedSenderOptions.includes(initialSenderAddress) ? initialSenderAddress : CUSTOM_SENDER,
  )

  // `addresses` loads asynchronously — on first open, the mount-time
  // initializer above almost always sees `addresses === []` and falls back
  // to Custom even when the saved address is one of the user's own. Once the
  // fetch resolves, re-classify — but only if the user hasn't touched the
  // picker since mount (still on Custom with the original saved value),
  // so an in-progress edit is never clobbered.
  useEffect(() => {
    if (
      senderMode === CUSTOM_SENDER &&
      senderAddress === initialSenderAddress &&
      fixedSenderOptions.includes(senderAddress)
    ) {
      setSenderMode(senderAddress)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, bridgeAddress])

  const [signature, setSignature] = useState(settings.signature ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const placeholder = `you@${BRIDGE_DOMAIN}`

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function handleSenderModeChange(value: string) {
    setSenderMode(value)
    if (value !== CUSTOM_SENDER) setSenderAddress(value)
  }

  async function handleSave() {
    if (!account || !active) {
      setError('Your session is locked — sign in again to save settings')
      return
    }
    setSaving(true)
    setError('')
    try {
      await save(
        { ...settings, senderAddress: senderAddress || undefined, signature: signature || undefined },
        account.pubkey,
        active,
      )
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-0 md:items-center md:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-2xl md:max-w-md md:rounded-xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="eyebrow flex-1">Settings</span>
          <IconButton title="Close settings" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-4 py-4">
          {account && (
            <Field label="Your addresses" hint={`Addresses linked to your account on ${BRIDGE_DOMAIN}.`}>
              {addressesLoading && (
                <p className="text-[11.5px] text-subtle">Loading your addresses…</p>
              )}
              {!addressesLoading && addressesError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
                  <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
                  <p className="flex-1 text-[11.5px] leading-relaxed text-destructive">
                    {addressesError}
                  </p>
                  <Button size="sm" onClick={reloadAddresses} className="flex-none">
                    Try again
                  </Button>
                </div>
              )}
              {!addressesLoading && !addressesError && addresses.length === 0 && (
                <p className="text-[11.5px] text-subtle">
                  No addresses yet. Your npub address below always works.
                </p>
              )}
              {!addressesLoading && !addressesError && addresses.length > 0 && (
                <div className="flex flex-col gap-1">
                  {addresses.map((addr) => (
                    <code
                      key={addr}
                      className="block w-full min-w-0 truncate rounded-md border border-input bg-muted px-3 py-2 font-mono text-[11px]"
                    >
                      {addr}
                    </code>
                  ))}
                </div>
              )}
            </Field>
          )}

          <Field
            label="Sender address"
            hint="Shown as the From address on mail you send."
          >
            <select
              value={senderMode}
              onChange={(e) => handleSenderModeChange(e.target.value)}
              className={inputClass}
            >
              {fixedSenderOptions.map((addr) => (
                <option key={addr} value={addr}>
                  {addr}
                </option>
              ))}
              <option value={CUSTOM_SENDER}>Custom…</option>
            </select>
            {senderMode === CUSTOM_SENDER && (
              <input
                value={senderAddress}
                onChange={(e) => setSenderAddress(e.target.value)}
                placeholder={placeholder}
                className={inputClass}
              />
            )}
          </Field>

          <Field
            label="Signature"
            hint="Added to the bottom of new messages, where you can still edit it before sending."
          >
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="Sent with Mail by Form*"
              rows={3}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
            />
          </Field>

          <Field label="Theme">
            <div
              role="radiogroup"
              aria-label="Theme"
              className="flex gap-1 rounded-md border border-input bg-background p-1"
            >
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={preference === t.id}
                  onClick={() => setPreference(t.id)}
                  className={[
                    'flex-1 rounded-sm px-2 py-1.5 text-[12px] font-medium transition-colors duration-[120ms]',
                    preference === t.id
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </Field>

          <p className="border-t border-border pt-4 text-[11px] leading-relaxed text-subtle">
            Your address, signature and sender settings are encrypted and synced to your relays
            as a kind 30078 event. Theme is kept on this device only.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-t border-border bg-destructive/10 px-4 py-2">
            <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
            <p className="text-[11.5px] leading-relaxed text-destructive">{error}</p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
