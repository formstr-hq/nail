import { useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { account, sk } = useAccountStore()
  const { settings, save } = useSettingsStore()

  const [senderAddress, setSenderAddress] = useState(settings.senderAddress ?? '')
  const [signature, setSignature] = useState(settings.signature ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const placeholder = `you@${BRIDGE_DOMAIN}`

  async function handleSave() {
    if (!account || !sk) {
      setError('Settings can only be saved with a secret key (not supported for NIP-07 yet)')
      return
    }
    setSaving(true)
    setError('')
    try {
      await save({ ...settings, senderAddress: senderAddress || undefined, signature: signature || undefined }, account.pubkey, sk)
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
          <div className="space-y-1">
            <label className="text-sm font-medium">Sender address</label>
            <p className="text-xs text-muted-foreground">
              Your bridge email address. Shown as the From: address when sending.
            </p>
            <input
              value={senderAddress}
              onChange={(e) => setSenderAddress(e.target.value)}
              placeholder={placeholder}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
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
