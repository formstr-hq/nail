import { useMailStore } from '@/store/mail'
import { useAccountStore } from '@/store/account'
import { AccountSwitcher } from '@/components/AccountSwitcher'
import { matchesAlias } from '@/lib/mail/aliasFilter'
import type { EmailFolder } from '@/types/mail'
import type { InboxStatus } from '@/hooks/useInbox'
import { BrandGlyph, PenIcon, SettingsIcon, InboxIcon, AtSignIcon } from '@/components/ui/icons'
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
  /** Open Settings straight to the Relays pane (from the relay status line). */
  onOpenRelays: () => void
  onAddAccount: () => void
  /** The account's own addresses, for the per-alias inbox filter. */
  aliases: string[]
  status: InboxStatus
}

/**
 * Relay health, stated only as far as it is known.
 *
 * A relay socket resolving is not proof of a live, accepting connection, so
 * "connected" would be a stronger claim than we can support. This says how many
 * relays are being listened to, which is a fact.
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
      <span className="h-1.5 w-1.5 flex-none rounded-full bg-positive" />
      <span className="truncate">
        {status.relays.length} {status.relays.length === 1 ? 'relay' : 'relays'}
        {status.decoding > 0 && ` · reading ${status.decoding}`}
      </span>
    </div>
  )
}

export function Sidebar({ onCompose, onSettings, onOpenRelays, onAddAccount, aliases, status }: SidebarProps) {
  const { folder, setFolder, emails, inboxFilter, setInboxFilter } = useMailStore()
  const { account } = useAccountStore()

  // The badge sits on the Inbox row, so it must count Inbox mail specifically —
  // the same predicate EmailList uses for the inbox folder. A global count also
  // tallies the self-copy every send wraps to us (which files under Sent),
  // showing an Inbox badge for a message the Inbox list never renders. It also
  // respects the active alias filter, so the badge matches what the list shows.
  const myPubkey = account?.pubkey
  const unread = Object.values(emails).filter((e) => {
    const unlabeled = !e.labels.some((l) => ['trash', 'archive', 'spam'].includes(l))
    if (!(unlabeled && e.senderPubkey !== myPubkey && !e.read)) return false
    return matchesAlias(e, inboxFilter)
  }).length

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-surface-nav">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <BrandGlyph size={20} />
        <span className="text-sm font-semibold tracking-tight">Mail</span>
        <span className="flex-1" />
        <ThemeToggle />
      </div>

      <div className="px-3 pb-4">
        {/* The one hero action — it wears the action colour, and being the
            single filled, raised control is what makes it read as "the thing
            to do". A clean neutral shadow lifts it off the flat nav; the pop is
            the colour, not a glow. */}
        <Button
          variant="action"
          onClick={onCompose}
          className="h-9 w-full shadow-md transition-all hover:-translate-y-px hover:shadow-lg active:translate-y-0 active:shadow"
        >
          <PenIcon className="h-3.5 w-3.5" />
          Write
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-2">
        {/* One row per address the account owns, so a user juggling several
            aliases can read each as its own inbox. Hidden when there is only
            the default address — a filter with a single option is just noise. */}
        {aliases.length > 1 && (
          <nav aria-label="Inboxes" className="flex flex-col gap-px px-2">
            <div className="eyebrow px-2 pb-1.5">Inboxes</div>
            <InboxOption
              icon={<InboxIcon className="h-3.5 w-3.5 flex-none" />}
              label="All mail"
              active={inboxFilter === null}
              onClick={() => setInboxFilter(null)}
            />
            {aliases.map((address) => (
              <InboxOption
                key={address}
                icon={<AtSignIcon className="h-3.5 w-3.5 flex-none" />}
                label={address}
                mono
                active={inboxFilter === address.toLowerCase()}
                onClick={() => setInboxFilter(address)}
              />
            ))}
          </nav>
        )}

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
      </div>

      <div className="mt-auto border-t border-border px-3 pb-3 pt-3">
        <AccountSwitcher onAddAccount={onAddAccount} />
        <button
          type="button"
          onClick={onOpenRelays}
          title="Relay settings"
          aria-label="Relay settings"
          className="-mx-1 block w-[calc(100%+0.5rem)] rounded-md px-1 text-left transition-colors hover:bg-accent/60"
        >
          <RelayState status={status} />
        </button>
        <div className="flex items-center gap-1 pt-2">
          <IconButton title="Settings" onClick={onSettings}>
            <SettingsIcon className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </aside>
  )
}

/** A single row in the Inboxes list — the "All mail" toggle or one alias. */
function InboxOption({
  icon,
  label,
  active,
  mono = false,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  mono?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      title={label}
      className={[
        'flex items-center gap-2 rounded-md border-l-2 px-2.5 py-1.5 text-left',
        'transition-colors duration-[120ms]',
        active
          ? 'border-l-primary bg-accent font-semibold text-foreground'
          : 'border-l-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      ].join(' ')}
    >
      <span className={active ? 'text-primary' : 'text-subtle'}>{icon}</span>
      <span className={['min-w-0 flex-1 truncate', mono ? 'font-mono text-[11px]' : 'text-[13px]'].join(' ')}>
        {label}
      </span>
    </button>
  )
}
