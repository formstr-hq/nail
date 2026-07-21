import { useState } from 'react'
import { useMailStore } from '@/store/mail'
import { useAccountStore } from '@/store/account'
import { useProfile } from '@/hooks/useProfile'
import type { EmailFolder } from '@/types/mail'
import type { InboxStatus } from '@/hooks/useInbox'
import {
  BrandGlyph,
  PenIcon,
  SettingsIcon,
  LogOutIcon,
  CopyIcon,
  CheckIcon,
} from '@/components/ui/icons'
import { Button, IconButton } from '@/components/ui/Button'
import { ThemeToggle } from '@/components/ui/ThemeToggle'

const FOLDERS: { id: EmailFolder; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'sent', label: 'Sent' },
  { id: 'archive', label: 'Archive' },
  { id: 'spam', label: 'Spam' },
  { id: 'trash', label: 'Trash' },
]

interface SidebarProps {
  onCompose: () => void
  onSettings: () => void
  status: InboxStatus
}

/**
 * Relay health, stated only as far as it is known.
 *
 * `publishToRelays` documents that nostr-tools resolves optimistically, so
 * "connected" would be a stronger claim than the pool can support. This says
 * how many relays are being listened to, which is a fact.
 */
function RelayState({ status }: { status: InboxStatus }) {
  if (status.phase === 'error') {
    return (
      <div className="flex items-center gap-1.5 px-1 pt-2 text-[10px] text-destructive">
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-destructive" />
        <span className="truncate">Relays unreachable</span>
      </div>
    )
  }

  if (status.phase === 'connecting') {
    return (
      <div className="flex items-center gap-1.5 px-1 pt-2 text-[10px] text-subtle">
        <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-subtle" />
        <span className="truncate">Connecting…</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 px-1 pt-2 font-mono text-[10px] text-subtle">
      <span className="h-1.5 w-1.5 flex-none rounded-full bg-primary" />
      <span className="truncate">
        {status.relays.length} {status.relays.length === 1 ? 'relay' : 'relays'}
        {status.decoding > 0 && ` · reading ${status.decoding}`}
      </span>
    </div>
  )
}

export function Sidebar({ onCompose, onSettings, status }: SidebarProps) {
  const { folder, setFolder, emails } = useMailStore()
  const { account, logout } = useAccountStore()
  const profile = useProfile(account?.pubkey)
  const [copied, setCopied] = useState(false)

  const unread = Object.values(emails).filter((e) => !e.read && !e.labels.includes('trash')).length

  async function copyNpub() {
    if (!account) return
    await navigator.clipboard.writeText(account.npub)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-surface-nav">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <BrandGlyph size={20} />
        <span className="text-sm font-semibold tracking-tight">Mail</span>
        <span className="flex-1" />
        <ThemeToggle />
      </div>

      <div className="px-3 pb-4">
        <Button variant="primary" onClick={onCompose} className="w-full">
          <PenIcon className="h-3.5 w-3.5" />
          Write
        </Button>
      </div>

      <nav aria-label="Mail folders" className="flex flex-col gap-px px-2">
        <div className="eyebrow px-2 pb-1.5">Folders</div>
        {FOLDERS.map((f) => {
          const active = folder === f.id
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFolder(f.id)}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex items-center justify-between rounded-md border-l-2 px-2.5 py-1.5 text-[13px]',
                'transition-colors duration-[120ms]',
                active
                  ? 'border-l-primary bg-accent font-semibold text-foreground'
                  : 'border-l-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              ].join(' ')}
            >
              <span>{f.label}</span>
              {f.id === 'inbox' && unread > 0 && (
                <span
                  className={[
                    'font-mono text-[10px] font-semibold tabular-nums',
                    active ? 'text-primary' : 'text-subtle',
                  ].join(' ')}
                >
                  {unread}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="mt-auto border-t border-border px-3 pb-3 pt-3">
        <div className="eyebrow px-1">Signed in as</div>
        <div className="flex items-center gap-1.5 px-1 pt-1">
          <span
            className={[
              'min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground',
              // With no kind-0 name the key itself is the identity, so it is
              // set in mono like every other key in the interface.
              profile.name ? '' : 'font-mono text-[10.5px] text-subtle',
            ].join(' ')}
            title={account?.npub}
          >
            {profile.name ?? account?.npub}
          </span>
          <IconButton title={copied ? 'Copied' : 'Copy your npub'} onClick={copyNpub}>
            {copied ? (
              <CheckIcon className="h-3.5 w-3.5 text-trust" />
            ) : (
              <CopyIcon className="h-3.5 w-3.5" />
            )}
          </IconButton>
        </div>
        <RelayState status={status} />
        <div className="flex items-center gap-1 pt-2">
          <IconButton title="Settings" onClick={onSettings}>
            <SettingsIcon className="h-4 w-4" />
          </IconButton>
          <IconButton title="Sign out" onClick={() => void logout()}>
            <LogOutIcon className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </aside>
  )
}
