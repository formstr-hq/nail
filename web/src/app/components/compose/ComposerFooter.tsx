import { Button } from '@/app/components/ui/Button'
import { LockIcon, LockOpenIcon } from '@/app/components/ui/icons'
import type { NoEncryptReason } from '@/app/hooks/compose/useComposerEncryption'

/**
 * The composer footer: From picker on the left, the encryption lock + Send on
 * the right.
 */
export function ComposerFooter(props: {
  fromAddress: string
  fromOptions: string[]
  onFromChange: (address: string) => void
  hasAlias: boolean
  /** The lock STATUS colors: encrypted → green, mixed → amber, off → red. */
  encrypt: boolean
  mixed: boolean
  canEncrypt: boolean
  missingKeysCount: number
  recipientsCount: number
  onToggleEncrypt: () => void
  onToggleLockInfo: () => void
  showLockInfo: boolean
  noEncryptReason: NoEncryptReason | null
  onDismissLockInfo: () => void
  onRunLockFix: () => void
  sending: boolean
  canSend: boolean
  onSend: () => void
}) {
  const {
    fromAddress,
    fromOptions,
    onFromChange,
    hasAlias,
    encrypt,
    mixed,
    canEncrypt,
    missingKeysCount,
    recipientsCount,
    onToggleEncrypt,
    onToggleLockInfo,
    showLockInfo,
    noEncryptReason,
    onDismissLockInfo,
    onRunLockFix,
    sending,
    canSend,
    onSend,
  } = props

  return (
    <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="eyebrow">From</div>
        <select
          value={fromAddress}
          // The closed select shows the selected address verbatim, and an
          // npub (npub1…@domain) is far wider than a phone's From column —
          // without truncation it overflows the box and draws over the Send
          // button. truncate clips it with an ellipsis in Chromium's WebView
          // (Capacitor); the dropdown options below still show the full
          // address, and title carries it for long-press/hover.
          title={fromAddress}
          onChange={(e) => onFromChange(e.target.value)}
          className="mt-0.5 w-full max-w-full truncate bg-transparent font-mono text-[10.5px] text-foreground focus:outline-none"
        >
          {fromOptions.map((a) => (
            <option key={a} value={a} className="font-mono">
              {a}
            </option>
          ))}
        </select>
        {/* No purchased alias yet: the npub works for mailstr.app mail, but
            anything external needs an alias. Nudge to the landing, where
            aliases are bought (the mail app lives at /mails, so "/" is the
            signup screen). Opens in a tab so the draft is preserved. */}
        {!hasAlias && (
          <a
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-[10.5px] text-muted-foreground underline hover:text-foreground"
          >
            Get an alias →
          </a>
        )}
      </div>
      <div className="relative flex-none">
        <button
          type="button"
          // A lock STATUS indicator: green closed lock when this message will
          // be encrypted, red open lock when it won't. Green → click toggles
          // encryption off; red → click reveals WHY it's off (a popover with
          // the reason, and a CTA to set up a key when that's the fix).
          onClick={() => {
            if (encrypt) onToggleEncrypt()
            else if (canEncrypt) onToggleEncrypt()
            else onToggleLockInfo()
          }}
          aria-label={
            encrypt
              ? mixed
                ? 'Partly encrypted — details'
                : 'Encrypted — click to turn off'
              : 'Not encrypted — why?'
          }
          title={
            encrypt
              ? mixed
                ? `Mixed: encrypted for ${recipientsCount - missingKeysCount}, plaintext for ${missingKeysCount}`
                : 'Encrypted with PGP — click to turn off'
              : canEncrypt
                ? 'Not encrypted — click to encrypt'
                : 'Not encrypted — click to see why'
          }
          className={[
            'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
            encrypt && !mixed
              ? 'text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-500'
              : encrypt && mixed
                ? 'text-amber-600 hover:bg-amber-500/10 dark:text-amber-500'
                : 'text-destructive hover:bg-destructive/10',
          ].join(' ')}
        >
          {encrypt ? <LockIcon className="h-4 w-4" /> : <LockOpenIcon className="h-4 w-4" />}
        </button>

        {showLockInfo && noEncryptReason && (
          <>
            {/* Click-away layer so the popover closes on any outside click. */}
            <div className="fixed inset-0 z-40" onClick={onDismissLockInfo} />
            <div className="absolute bottom-full right-0 z-50 mb-2 w-60 rounded-md border border-border bg-card p-3 shadow-lg">
              <div className="flex items-start gap-2">
                <LockOpenIcon
                  className={`mt-px h-3.5 w-3.5 flex-none ${encrypt && mixed ? 'text-amber-600 dark:text-amber-500' : 'text-destructive'}`}
                />
                <p className="text-[11.5px] leading-relaxed text-foreground">
                  {noEncryptReason.text}
                </p>
              </div>
              {noEncryptReason.action && (
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-2 w-full"
                  onClick={onRunLockFix}
                >
                  {noEncryptReason.cta}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      <Button variant="primary" onClick={onSend} disabled={!canSend}>
        {sending ? 'Sending…' : 'Send'}
      </Button>
    </div>
  )
}