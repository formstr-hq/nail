import { useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { friendlyUnlockError } from '@/lib/loginUi'
import { Button } from '@/app/components/ui/Button'

/** Passphrase prompt for a persisted ncryptsec account after a reload. */
export function UnlockForm({ onUseAnother }: { onUseAnother: () => void }) {
  const { account, unlockNcryptsec } = useAccountStore()
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await unlockNcryptsec(passphrase)
    } catch (err) {
      setError(friendlyUnlockError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleUnlock} className="flex flex-col gap-3">
      <div className="text-center">
        <div className="eyebrow">Locked</div>
        <p className="truncate pt-1 font-mono text-[11px] text-subtle" title={account?.npub}>
          {account?.npub}
        </p>
      </div>
      <input
        type="password"
        autoFocus
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
      />
      <Button type="submit" variant="primary" disabled={!passphrase || busy} className="w-full">
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
      <button
        type="button"
        onClick={onUseAnother}
        className="text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        Use a different account
      </button>
      {error && <p className="text-center text-[12px] text-destructive">{error}</p>}
    </form>
  )
}
