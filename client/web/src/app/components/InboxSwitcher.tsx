import { useEffect, useMemo, useState } from 'react'
import {
  groupAddressesByDomain,
  isPinnedInbox,
  PINNED_INBOX_LIMIT,
  recentInboxes,
  type AliasInboxStats,
} from '@/app/lib/mail/inboxAddresses'
import {
  AtSignIcon,
  InboxIcon,
  SearchIcon,
  StarIcon,
  XIcon,
} from '@/app/components/ui/icons'
import { IconButton } from '@/app/components/ui/Button'
import { Overlay } from '@/app/components/ui/Overlay'

interface InboxSwitcherProps {
  aliases: string[]
  /** The active alias filter, lowercased, or null for All mail. */
  current: string | null
  /** Pinned addresses, in display casing and user order. */
  pinned: string[]
  stats: ReadonlyMap<string, AliasInboxStats>
  onSelect: (address: string | null) => void
  /** Persist the new pin set; reject with a message to keep the picker open. */
  onTogglePin: (address: string) => Promise<void>
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow px-2 pb-1 pt-2">{children}</div>
}

/**
 * The scalable "Inboxes" entry point.
 *
 * The sidebar only renders a handful of address rows. This button opens the
 * complete list in a searchable picker — grouped by domain, with per-address
 * unread counts and pin controls — so a customer with hundreds of purchased
 * addresses can still find one without turning the nav into a mailing list.
 */
export function InboxSwitcher({
  aliases,
  current,
  pinned,
  stats,
  onSelect,
  onTogglePin,
}: InboxSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [pinBusy, setPinBusy] = useState<string | null>(null)

  const pinnedKeys = useMemo(
    () => new Set(pinned.map((address) => address.toLowerCase())),
    [pinned],
  )
  const currentKey = current?.toLowerCase() ?? null

  const recent = useMemo(() => {
    const exclude = new Set(pinnedKeys)
    if (currentKey) exclude.add(currentKey)
    return recentInboxes(aliases, stats, exclude)
  }, [aliases, stats, pinnedKeys, currentKey])

  const groups = useMemo(
    () =>
      groupAddressesByDomain(
        aliases.filter((address) => !pinnedKeys.has(address.toLowerCase())),
      ),
    [aliases, pinnedKeys],
  )

  const needle = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return []
    return aliases
      .filter((address) => address.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [aliases, needle])

  function close() {
    setOpen(false)
    setQuery('')
    setError('')
  }

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setQuery('')
      setError('')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  async function togglePin(address: string) {
    if (pinBusy) return
    const isPinned = isPinnedInbox(pinned, address)
    if (!isPinned && pinned.length >= PINNED_INBOX_LIMIT) {
      setError(`Pin up to ${PINNED_INBOX_LIMIT} addresses. Unpin one first.`)
      return
    }
    setPinBusy(address)
    setError('')
    try {
      await onTogglePin(address)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPinBusy(null)
    }
  }

  function choose(address: string | null) {
    onSelect(address)
    close()
  }

  function renderAddress(address: string) {
    const key = address.toLowerCase()
    const isPinned = pinnedKeys.has(key)
    const canPin = isPinned || pinned.length < PINNED_INBOX_LIMIT
    return (
      <AddressRow
        key={address}
        address={address}
        active={currentKey === key}
        pinned={isPinned}
        unread={stats.get(key)?.unread ?? 0}
        canPin={canPin}
        pinBusy={pinBusy !== null}
        onSelect={() => choose(address)}
        onTogglePin={() => void togglePin(address)}
      />
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={[
          'flex items-center gap-2 rounded-md border-l-2 border-l-transparent px-3 py-2.5 text-left',
          'text-[13px] text-muted-foreground transition-colors duration-[120ms]',
          'hover:bg-accent/60 hover:text-foreground',
        ].join(' ')}
      >
        <SearchIcon className="h-4 w-4 flex-none text-subtle" />
        <span className="min-w-0 flex-1">All addresses</span>
        <span className="font-mono text-[10px] font-semibold tabular-nums text-subtle">
          {aliases.length}
        </span>
      </button>

      {open && (
        <Overlay
          dismiss={close}
          height="dialog"
          align="bottom-sheet"
          safe="bottom"
          className="bg-foreground/40 backdrop-blur-sm"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="inbox-picker-title"
            className="flex max-h-[82vh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-2xl md:max-h-[70vh] md:max-w-md md:rounded-xl"
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="eyebrow">Inboxes</div>
                <h2
                  id="inbox-picker-title"
                  className="text-sm font-semibold tracking-tight"
                >
                  Choose an address
                </h2>
              </div>
              <IconButton title="Close" onClick={close}>
                <XIcon className="h-4 w-4" />
              </IconButton>
            </div>

            <div className="border-b border-border px-4 py-3">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    if (error) setError('')
                  }}
                  placeholder="Search addresses"
                  aria-label="Search addresses"
                  className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-[12px] text-foreground placeholder:text-subtle focus:outline-none"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
              {error && (
                <p className="mx-2 mt-1 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11.5px] leading-relaxed text-destructive">
                  {error}
                </p>
              )}

              {needle ? (
                matches.length > 0 ? (
                  <section aria-label="Results">
                    <SectionLabel>Results</SectionLabel>
                    {matches.map(renderAddress)}
                  </section>
                ) : (
                  <p className="px-3 py-8 text-center text-[12px] text-subtle">
                    No addresses match “{query.trim()}”.
                  </p>
                )
              ) : (
                <>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => choose(null)}
                      aria-current={currentKey === null ? 'true' : undefined}
                      className={[
                        'flex w-full items-center gap-2 rounded-md border-l-2 px-2 py-2 text-left',
                        'transition-colors duration-[120ms]',
                        currentKey === null
                          ? 'border-l-primary bg-accent font-semibold text-foreground'
                          : 'border-l-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                      ].join(' ')}
                    >
                      <InboxIcon
                        className={[
                          'h-4 w-4 flex-none',
                          currentKey === null ? 'text-primary' : 'text-subtle',
                        ].join(' ')}
                      />
                      <span className="text-[13px]">All mail</span>
                    </button>
                  </div>

                  {pinned.length > 0 && (
                    <section aria-label="Pinned">
                      <SectionLabel>Pinned</SectionLabel>
                      {pinned.map(renderAddress)}
                    </section>
                  )}

                  {recent.length > 0 && (
                    <section aria-label="Recently active">
                      <SectionLabel>Recently active</SectionLabel>
                      {recent.map(renderAddress)}
                    </section>
                  )}

                  {groups.map((group) => (
                    <section
                      key={group.domain}
                      aria-label={group.domain || 'Other addresses'}
                    >
                      <SectionLabel>
                        {group.domain || 'Other addresses'}
                      </SectionLabel>
                      {group.addresses.map(renderAddress)}
                    </section>
                  ))}
                </>
              )}
            </div>

            <div className="border-t border-border px-4 py-2 text-[10.5px] leading-relaxed text-subtle">
              {pinned.length >= PINNED_INBOX_LIMIT
                ? `Pin limit reached (${pinned.length}/${PINNED_INBOX_LIMIT}). Unpin one to add another.`
                : `Pin up to ${PINNED_INBOX_LIMIT} addresses for the sidebar. Search covers every address.`}
            </div>
          </div>
        </Overlay>
      )}
    </>
  )
}

function AddressRow({
  address,
  active,
  pinned,
  unread,
  canPin,
  pinBusy,
  onSelect,
  onTogglePin,
}: {
  address: string
  active: boolean
  pinned: boolean
  unread: number
  canPin: boolean
  pinBusy: boolean
  onSelect: () => void
  onTogglePin: () => void
}) {
  const pinLabel = pinned ? `Unpin ${address}` : `Pin ${address}`
  const pinTitle =
    !pinned && !canPin ? 'Unpin an address first' : pinLabel
  return (
    <div
      className={[
        'flex items-center gap-1 rounded-md border-l-2 pr-1',
        active
          ? 'border-l-primary bg-accent'
          : 'border-l-transparent hover:bg-accent/60',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        title={address}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2 pr-1 text-left"
      >
        <AtSignIcon
          className={[
            'h-4 w-4 flex-none',
            active ? 'text-primary' : 'text-subtle',
          ].join(' ')}
        />
        <span
          className={[
            'min-w-0 flex-1 truncate font-mono text-[12px]',
            active
              ? 'font-semibold text-foreground'
              : 'text-muted-foreground',
          ].join(' ')}
        >
          {address}
        </span>
        {unread > 0 && (
          <span className="font-mono text-[10px] font-semibold tabular-nums text-primary">
            {unread}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        disabled={!canPin || pinBusy}
        title={pinTitle}
        aria-label={pinLabel}
        className="flex-none rounded p-1.5 text-subtle transition-colors hover:text-foreground disabled:opacity-40"
      >
        <StarIcon
          className={[
            'h-3.5 w-3.5',
            pinned ? 'fill-current text-primary' : '',
          ].join(' ')}
        />
      </button>
    </div>
  )
}
