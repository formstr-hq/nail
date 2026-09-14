import { Loader2 } from 'lucide-react'
import type { StoredAccount } from '@formstr/signer'

/** Focused passphrase unlock for a stored ncryptsec account (purchase mode). */
export function UnlockStoredForm({
  account,
  passphrase,
  busy,
  onPassphraseChange,
  onSubmit,
  onUseAnother,
}: {
  account: StoredAccount
  passphrase: string
  busy: boolean
  onPassphraseChange: (value: string) => void
  onSubmit: () => void
  onUseAnother: () => void
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="flex flex-col gap-3"
    >
      <p className="text-sm text-gray-600">
        Continue as{' '}
        <span className="font-mono text-[13px] font-medium text-ink" title={account.npub}>
          {account.npub.slice(0, 12)}…{account.npub.slice(-4)}
        </span>
      </p>
      <input
        type="password"
        name="off"
        autoFocus
        value={passphrase}
        onChange={(e) => onPassphraseChange(e.target.value)}
        placeholder="Passphrase for this key"
        aria-label="Passphrase for this key"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="w-full rounded-lg border border-ink/15 bg-white px-4 py-3 text-sm text-ink outline-none focus:border-primary"
      />
      <button
        type="submit"
        disabled={!passphrase || busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-light disabled:opacity-50"
      >
        {busy && <Loader2 size={15} className="animate-spin" />}
        {busy ? 'Unlocking…' : 'Unlock and continue'}
      </button>
      <button
        type="button"
        onClick={onUseAnother}
        className="text-sm text-gray-500 transition-colors hover:text-ink"
      >
        Use a different key
      </button>
    </form>
  )
}
