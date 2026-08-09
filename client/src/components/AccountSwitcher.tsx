import { useState } from 'react'
import type { StoredAccount } from '@formstr/signer'
import { useAccountStore } from '@/store/account'
import { useProfile } from '@/hooks/useProfile'
import { Avatar } from '@/components/ui/Avatar'
import { IconButton } from '@/components/ui/Button'
import {
  ChevronDownIcon,
  PlusIcon,
  LogOutIcon,
  CopyIcon,
  CheckIcon,
} from '@/components/ui/icons'

/** npub1abcd…wxyz — enough to recognise an account without the full 63 chars. */
function shortNpub(npub: string): string {
  return npub.length > 18 ? `${npub.slice(0, 10)}…${npub.slice(-6)}` : npub
}

/** One selectable account in the popover; its own hook resolves its kind-0. */
function AccountRow({
  account,
  active,
  onSelect,
}: {
  account: StoredAccount
  active: boolean
  onSelect: () => void
}) {
  const profile = useProfile(account.pubkey)
  const label = profile.name ?? account.npub
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={[
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/60',
      ].join(' ')}
    >
      <Avatar label={label} picture={profile.picture} size={26} />
      <span className="min-w-0 flex-1">
        <span
          className={[
            'block truncate text-[12.5px] text-foreground',
            profile.name ? 'font-medium' : 'font-mono text-[11px] text-subtle',
          ].join(' ')}
        >
          {profile.name ?? shortNpub(account.npub)}
        </span>
        {profile.name && (
          <span className="block truncate font-mono text-[10px] text-subtle">
            {shortNpub(account.npub)}
          </span>
        )}
      </span>
      {active && <CheckIcon className="h-3.5 w-3.5 flex-none text-primary" />}
    </button>
  )
}

/**
 * The signed-in identity, and the door to every other one.
 *
 * The button shows who you are now; opening it lists every account the signer
 * holds so you can hop between inboxes without signing out, add another, or
 * leave. Switching hands off to the store, which re-locks and silently
 * re-unlocks the target (see `switchTo`).
 */
export function AccountSwitcher({ onAddAccount }: { onAddAccount: () => void }) {
  const { account, accounts, switchTo, logout } = useAccountStore()
  const profile = useProfile(account?.pubkey)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!account) return null

  async function copyNpub() {
    if (!account) return
    await navigator.clipboard.writeText(account.npub)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="relative">
      <div className="eyebrow px-1">Signed in as</div>
      <div className="flex items-center gap-1 px-0.5 pt-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/60"
        >
          <Avatar label={profile.name ?? account.npub} picture={profile.picture} size={26} />
          <span
            className={[
              'min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground',
              profile.name ? '' : 'font-mono text-[10.5px] text-subtle',
            ].join(' ')}
            title={account.npub}
          >
            {profile.name ?? account.npub}
          </span>
          <ChevronDownIcon
            className={['h-3.5 w-3.5 flex-none text-subtle transition-transform', open ? 'rotate-180' : ''].join(' ')}
          />
        </button>
        <IconButton title={copied ? 'Copied' : 'Copy your npub'} onClick={copyNpub}>
          {copied ? (
            <CheckIcon className="h-3.5 w-3.5 text-trust" />
          ) : (
            <CopyIcon className="h-3.5 w-3.5" />
          )}
        </IconButton>
      </div>

      {open && (
        <>
          {/* Click-away layer — a plain backdrop so any outside click closes
              the popover without a document-level listener. */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full left-0 right-0 z-20 mb-1 rounded-lg border border-border bg-card p-1 shadow-lg">
            {accounts.length > 1 && <div className="eyebrow px-2 pb-1 pt-1">Accounts</div>}
            <div className="flex max-h-56 flex-col gap-px overflow-y-auto">
              {accounts.map((a) => (
                <AccountRow
                  key={a.pubkey}
                  account={a}
                  active={a.pubkey === account.pubkey}
                  onSelect={() => {
                    setOpen(false)
                    if (a.pubkey !== account.pubkey) void switchTo(a.pubkey)
                  }}
                />
              ))}
            </div>
            <div className="my-1 border-t border-border" />
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onAddAccount()
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Add another account
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                void logout()
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <LogOutIcon className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}
