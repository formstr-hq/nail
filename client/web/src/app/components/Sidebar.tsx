import { useCallback, useMemo } from 'react'
import { useMailStore } from '@/app/store/mail'
import { useAccountStore } from '@/app/store/account'
import { useEffectiveSenders } from '@/app/hooks/useEffectiveSenders'
import { useAliasInboxStats } from '@/app/hooks/useAliasInboxStats'
import { AccountSwitcher } from '@/app/components/AccountSwitcher'
import { InboxSwitcher } from '@/app/components/InboxSwitcher'
import { matchesAlias } from '@/app/lib/mail/aliasFilter'
import { useSettingsStore } from '@/app/store/settings'
import { foldersOf, resolveFolder, sortFolders } from '@/app/lib/mail/folders'
import {
  normalizePinnedInboxes,
  PINNED_INBOX_LIMIT,
  SHOW_ALL_INBOXES_LIMIT,
} from '@/app/lib/mail/inboxAddresses'
import type { InboxStatus } from '@/app/hooks/useInbox'
import { BrandGlyph, PenIcon, SettingsIcon, InboxIcon, AtSignIcon, PlusIcon } from '@/app/components/ui/icons'
import calendarAppIcon from '@/app/assets/calendar-app-icon.png'
import { Button, IconButton } from '@/app/components/ui/Button'
import { ThemeToggle } from '@/app/components/ui/ThemeToggle'

interface SidebarProps {
  onCompose: () => void
  onSettings: () => void
  /** Open Settings straight to the Relays pane (from the relay status line). */
  onOpenRelays: () => void
  onAddAccount: () => void
  /** Open the in-app "buy a new address" flow. */
  onBuyAddress: () => void
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

export function Sidebar({ onCompose, onSettings, onOpenRelays, onAddAccount, onBuyAddress, aliases, status }: SidebarProps) {
  const { folder, setFolder, emails, mailState, inboxFilter, setInboxFilter } = useMailStore()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const folders = sortFolders(foldersOf(settings))
  const { account, active } = useAccountStore()
  // Effective senders, so an unbacked (possibly spoofed) header never files a
  // message under one of the user's aliases.
  const effectiveFrom = useEffectiveSenders()
  const aliasStats = useAliasInboxStats(aliases, effectiveFrom)

  // Above the flat-list threshold the sidebar shows a stable, bounded subset:
  // pinned addresses plus whichever address is currently selected. Everything
  // else lives in the searchable InboxSwitcher.
  const pinned = useMemo(
    () => normalizePinnedInboxes(settings.pinnedInboxes, aliases),
    [settings.pinnedInboxes, aliases],
  )
  const pinnedKeys = useMemo(
    () => new Set(pinned.map((address) => address.toLowerCase())),
    [pinned],
  )
  const currentAddress =
    inboxFilter != null
      ? (aliases.find((address) => address.toLowerCase() === inboxFilter) ?? null)
      : null
  const currentUnpinned =
    currentAddress && !pinnedKeys.has(currentAddress.toLowerCase())
      ? currentAddress
      : null
  const compactInboxes = aliases.length > SHOW_ALL_INBOXES_LIMIT

  const togglePin = useCallback(
    async (address: string) => {
      if (!account || !active) {
        throw new Error('Sign in again to change pinned inboxes.')
      }
      // Read the live blob, not the rendered snapshot: two quick pin clicks
      // must compose instead of the second overwriting the first.
      const livePins = normalizePinnedInboxes(
        useSettingsStore.getState().settings.pinnedInboxes,
        aliases,
      )
      const key = address.toLowerCase()
      const isPinned = livePins.some((pin) => pin.toLowerCase() === key)
      const next = isPinned
        ? livePins.filter((pin) => pin.toLowerCase() !== key)
        : [...livePins, address]
      if (next.length > PINNED_INBOX_LIMIT) {
        throw new Error(
          `Pin up to ${PINNED_INBOX_LIMIT} addresses. Unpin one first.`,
        )
      }

      const previous = useSettingsStore.getState().settings.pinnedInboxes
      const stored = next.map((pin) => pin.toLowerCase())
      // The star should feel instant; the settings event catches up behind it.
      useSettingsStore.getState().update({ pinnedInboxes: stored })
      try {
        await save({ pinnedInboxes: stored }, account.pubkey, active)
      } catch (e) {
        // Roll back the optimistic star if the relay/signer rejected the write.
        useSettingsStore.getState().update({ pinnedInboxes: previous })
        throw e
      }
    },
    [account, active, aliases, save],
  )

  // The badge sits on the Inbox row, so it must count Inbox mail specifically —
  // the same predicate EmailList uses for the inbox folder. A global count also
  // tallies the self-copy every send wraps to us (which files under Sent),
  // showing an Inbox badge for a message the Inbox list never renders. It also
  // respects the active alias filter, so the badge matches what the list shows.
  const myPubkey = account?.pubkey
  const unread = Object.values(emails).filter((e) => {
    const flags = mailState[e.id]
    const read = flags?.read ?? e.read
    if (read || e.senderPubkey === myPubkey) return false
    // Inbox is the natural, unfiled mailbox plus an explicit 'inbox'
    // override. A match that files elsewhere (Spam included) does not count.
    const resolved = resolveFolder(e, flags, folders)
    if (resolved && resolved !== 'inbox') return false
    return matchesAlias(e, inboxFilter, effectiveFrom.get(e.id))
  }).length

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-surface-nav">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <BrandGlyph size={24} />
        <span className="text-base font-semibold tracking-tight">Mail</span>
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
        {/* The account's addresses as inboxes. Small accounts keep the familiar
            flat list; once it would take over the sidebar, only pinned and
            current addresses stay as rows and the full list moves into the
            searchable InboxSwitcher. Hidden for a single address — a filter
            with one option is just noise. */}
        {aliases.length > 1 && (
          <nav aria-label="Inboxes" className="flex flex-col gap-px px-2">
            <div className="eyebrow px-2 pb-1.5">Inboxes</div>
            <InboxOption
              icon={<InboxIcon className="h-4 w-4 flex-none" />}
              label="All mail"
              active={inboxFilter === null}
              onClick={() => setInboxFilter(null)}
            />
            {compactInboxes ? (
              <>
                {pinned.map((address) => (
                  <InboxOption
                    key={address}
                    icon={<AtSignIcon className="h-4 w-4 flex-none" />}
                    label={address}
                    mono
                    count={aliasStats.get(address.toLowerCase())?.unread}
                    active={inboxFilter === address.toLowerCase()}
                    onClick={() => setInboxFilter(address)}
                  />
                ))}
                {currentUnpinned && (
                  <InboxOption
                    icon={<AtSignIcon className="h-4 w-4 flex-none" />}
                    label={currentUnpinned}
                    mono
                    count={aliasStats.get(currentUnpinned.toLowerCase())?.unread}
                    active
                    onClick={() => setInboxFilter(currentUnpinned)}
                  />
                )}
                <InboxSwitcher
                  aliases={aliases}
                  current={inboxFilter}
                  pinned={pinned}
                  stats={aliasStats}
                  onSelect={setInboxFilter}
                  onTogglePin={togglePin}
                />
              </>
            ) : (
              aliases.map((address) => (
                <InboxOption
                  key={address}
                  icon={<AtSignIcon className="h-4 w-4 flex-none" />}
                  label={address}
                  mono
                  count={aliasStats.get(address.toLowerCase())?.unread}
                  active={inboxFilter === address.toLowerCase()}
                  onClick={() => setInboxFilter(address)}
                />
              ))
            )}
          </nav>
        )}

        {/* The buy action sits directly under the alias inboxes it extends —
            an action row, not a filter, so it stays outside that nav and is
            always visible (even with no aliases yet). */}
        <nav aria-label="Address" className="flex flex-col gap-px px-2">
          <button
            type="button"
            onClick={onBuyAddress}
            className={[
              'flex items-center gap-2 rounded-md border-l-2 border-l-transparent px-3 py-2.5 text-left',
              'text-[15px] text-muted-foreground transition-colors duration-[120ms]',
              'hover:bg-accent/60 hover:text-foreground',
            ].join(' ')}
          >
            <PlusIcon className="h-4 w-4 flex-none text-subtle" />
            <span>Buy a new address</span>
          </button>
        </nav>

        <nav aria-label="Mail folders" className="flex flex-col gap-px px-2">
          <div className="eyebrow px-2 pb-1.5">Folders</div>
          {folders.map((f) => {
            const active = folder === f.id
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFolder(f.id)}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex items-center justify-between rounded-md border-l-2 px-3 py-2.5 text-[15px]',
                  'transition-colors duration-[120ms]',
                  active
                    ? 'border-l-primary bg-accent font-semibold text-foreground'
                    : 'border-l-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                ].join(' ')}
              >
                <span>{f.name}</span>
                {f.id === 'inbox' && unread > 0 && (
                  <span
                    className={[
                      'font-mono text-[11px] font-semibold tabular-nums',
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

        {/* Sibling app, not a mail folder — it navigates away, so it's an
            external link styled to sit alongside the folders rather than a
            folder button that swaps the pane. */}
        <nav aria-label="Apps" className="flex flex-col gap-px px-2">
          <div className="eyebrow px-2 pb-1.5">Apps</div>
          <a
            href="https://calendar.formstr.app"
            target="_blank"
            rel="noopener noreferrer"
            className={[
              'flex items-center gap-2 rounded-md border-l-2 border-l-transparent px-3 py-2.5',
              'text-[15px] text-muted-foreground transition-colors duration-[120ms]',
              'hover:bg-accent/60 hover:text-foreground',
            ].join(' ')}
          >
            {/* The nostr-calendar app's own tile icon, so the entry reads as a
                link to that app rather than a generic calendar action. */}
            <img
              src={calendarAppIcon}
              alt=""
              className="h-4 w-4 flex-none rounded-[3px]"
            />
            <span>Calendar</span>
          </a>
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
  count,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  mono?: boolean
  /** Unread Inbox messages for this alias, when known. */
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      title={label}
      className={[
        'flex items-center gap-2 rounded-md border-l-2 px-3 py-2.5 text-left',
        'transition-colors duration-[120ms]',
        active
          ? 'border-l-primary bg-accent font-semibold text-foreground'
          : 'border-l-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      ].join(' ')}
    >
      <span className={active ? 'text-primary' : 'text-subtle'}>{icon}</span>
      <span className={['min-w-0 flex-1 truncate', mono ? 'font-mono text-[13px]' : 'text-[15px]'].join(' ')}>
        {label}
      </span>
      {count != null && count > 0 && (
        <span
          className={[
            'font-mono text-[10px] font-semibold tabular-nums',
            active ? 'text-primary' : 'text-subtle',
          ].join(' ')}
        >
          {count}
        </span>
      )}
    </button>
  )
}
