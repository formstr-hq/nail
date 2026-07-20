import { useEffect, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { useOwnedAddresses } from '@/hooks/useOwnedAddresses'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'

// Sentinel select value for "type your own address" — kept distinct from any
// real address string so it can never collide with an owned/bridge option.
const CUSTOM_SENDER = '__custom__'

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { account, active } = useAccountStore()
  const { settings, save } = useSettingsStore()
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
  const [copied, setCopied] = useState(false)

  const placeholder = `you@${BRIDGE_DOMAIN}`

  async function copyNpub() {
    if (!account) return
    await navigator.clipboard.writeText(account.npub)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

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
      await save({ ...settings, senderAddress: senderAddress || undefined, signature: signature || undefined }, account.pubkey, active)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-medium">Settings</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">&times;</button>
        </div>

        <div className="p-4 space-y-4">
          {account && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Your npub</label>
              <p className="text-xs text-muted-foreground">
                Your public Nostr identity. Share it to receive mail directly.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate rounded-md border border-input bg-muted px-3 py-2 text-xs font-mono">
                  {account.npub}
                </code>
                <button
                  onClick={copyNpub}
                  className="shrink-0 px-3 py-2 text-xs rounded-md border border-input hover:bg-accent transition-colors"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {account && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Your addresses</label>
              <p className="text-xs text-muted-foreground">
                Mailstr.app addresses linked to your account.
              </p>
              {addressesLoading && (
                <p className="text-xs text-muted-foreground">Loading…</p>
              )}
              {!addressesLoading && addressesError && (
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-xs text-destructive">{addressesError}</p>
                  <button
                    onClick={reloadAddresses}
                    className="shrink-0 px-3 py-2 text-xs rounded-md border border-input hover:bg-accent transition-colors"
                  >
                    Retry
                  </button>
                </div>
              )}
              {!addressesLoading && !addressesError && addresses.length === 0 && (
                <p className="text-xs text-muted-foreground">No addresses yet</p>
              )}
              {!addressesLoading && !addressesError && addresses.length > 0 && (
                <div className="space-y-1">
                  {addresses.map((addr) => (
                    <code
                      key={addr}
                      className="block w-full min-w-0 truncate rounded-md border border-input bg-muted px-3 py-2 text-xs font-mono"
                    >
                      {addr}
                    </code>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium">Sender address</label>
            <p className="text-xs text-muted-foreground">
              Your bridge email address. Shown as the From: address when sending.
            </p>
            <select
              value={senderMode}
              onChange={(e) => handleSenderModeChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Email signature</label>
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="-- &#10;Sent via Mail by Form*"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Settings are encrypted and synced to your relays (Kind 30078).
          </p>
        </div>

        {error && <p className="px-4 pb-2 text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded-md border border-input hover:bg-accent transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
