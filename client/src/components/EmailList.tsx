import { useMailStore, isFiled } from '@/store/mail'
import { useAccountStore } from '@/store/account'
import { useMailActions } from '@/hooks/useMailActions'
import { matchesAlias } from '@/lib/mail/aliasFilter'
import type { Email, EmailFolder } from '@/types/mail'
import type { InboxStatus } from '@/hooks/useInbox'
import { useState } from 'react'
import { SenderProofLine } from '@/components/ui/SenderProof'
import { SearchIcon, InboxIcon, AlertIcon, RefreshIcon } from '@/components/ui/icons'
import { Button, IconButton } from '@/components/ui/Button'

const FOLDER_LABEL: Record<EmailFolder, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  archive: 'Archive',
  spam: 'Spam',
  trash: 'Trash',
}

/** What an empty folder should say. Each one names the action that fills it. */
const EMPTY_COPY: Record<EmailFolder, { title: string; body: string }> = {
  inbox: {
    title: 'No mail yet',
    body: 'Messages sent to your address land here. Share your address to get started.',
  },
  sent: { title: 'Nothing sent yet', body: 'Messages you send will be kept here.' },
  archive: { title: 'Archive is empty', body: 'Messages you archive are filed here.' },
  spam: { title: 'No spam', body: 'Messages marked as spam are held here.' },
  trash: { title: 'Trash is empty', body: 'Deleted messages wait here before they go.' },
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short' })
}

function EmailRow({ email, read, selected }: { email: Email; read: boolean; selected: boolean }) {
  const setSelected = useMailStore((s) => s.setSelected)
  const { markRead } = useMailActions()

  function handleClick() {
    setSelected(email.id)
    markRead(email.id)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-current={selected ? 'true' : undefined}
      className={[
        'w-full border-b border-l-2 border-b-border px-3.5 py-2.5 text-left',
        'transition-colors duration-[120ms]',
        selected
          ? 'border-l-primary bg-accent'
          : read
            ? 'border-l-transparent hover:bg-accent/50'
            : 'border-l-primary/40 hover:bg-accent/50',
      ].join(' ')}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={[
            'truncate text-[12.5px]',
            read ? 'font-medium text-foreground' : 'font-bold text-foreground',
            // An unproved sender is shown by key, so render it as one.
            email.senderProof === 'none' ? 'font-mono text-[11.5px]' : '',
          ].join(' ')}
        >
          {email.from.name || email.from.address}
        </span>
        <span className="flex-none font-mono text-[10px] tabular-nums text-subtle">
          {formatDate(email.timestamp)}
        </span>
      </div>

      <div
        className={[
          'mt-px truncate text-[12.5px]',
          read ? 'text-muted-foreground' : 'font-semibold text-foreground',
        ].join(' ')}
      >
        {email.subject}
      </div>

      {email.body.trim() && (
        <div className="mt-px truncate text-[11.5px] text-subtle">{email.body.trim()}</div>
      )}

      <div className="mt-1.5">
        <SenderProofLine proof={email.senderProof} />
      </div>
    </button>
  )
}

/** Centred message for the three non-list states. Same shape each time. */
function ListState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      <div className="text-subtle">{icon}</div>
      <p className="text-[13px] font-semibold text-foreground">{title}</p>
      <p className="max-w-[34ch] text-[11.5px] leading-relaxed text-muted-foreground">{body}</p>
      {action}
    </div>
  )
}

export function EmailList({ status, onRetry }: { status: InboxStatus; onRetry: () => void }) {
  const { emails, mailState, folder, selectedId, query, setQuery, inboxFilter } = useMailStore()
  const myPubkey = useAccountStore((s) => s.account?.pubkey)
  // Spin the icon briefly on tap so the refresh reads as "doing something" even
  // when the cache answers instantly and nothing visibly changes.
  const [refreshing, setRefreshing] = useState(false)
  function handleRefresh() {
    onRetry()
    setRefreshing(true)
    setTimeout(() => setRefreshing(false), 800)
  }

  const inFolder = Object.values(emails)
    .filter((e) => {
      // Scope to the selected alias first, so every folder count and list
      // reflects the inbox the user picked.
      if (!matchesAlias(e, inboxFilter)) return false
      const flags = mailState[e.id]
      // Trash wins over archive: a mail flagged both (e.g. archived, then
      // deleted) belongs in Trash, matching how restore clears both.
      if (folder === 'trash') return !!flags?.trashed
      if (folder === 'archive') return !!flags?.archived && !flags?.trashed
      // Spam stays server-side, surfaced via labels — not a client metadata flag.
      if (folder === 'spam') return e.labels.includes('spam')
      if (isFiled(flags)) return false
      // Sent = the self-copy we wrap to ourselves; Inbox = everything else
      if (folder === 'sent') return e.senderPubkey === myPubkey
      return e.senderPubkey !== myPubkey
    })
    .sort((a, b) => b.timestamp - a.timestamp)

  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? inFolder.filter((e) =>
        [e.subject, e.body, e.from.name ?? '', e.from.address]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : inFolder

  const readOf = (e: Email) => mailState[e.id]?.read ?? e.read
  const unread = inFolder.filter((e) => !readOf(e)).length

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-list">
      <header className="border-b border-border px-3.5 py-3">
        <div className="flex items-center justify-between pb-2">
          <span className="eyebrow">{FOLDER_LABEL[folder]}</span>
          <div className="flex items-center gap-2">
            {unread > 0 && (
              <span className="font-mono text-[10px] font-semibold tabular-nums text-primary">
                {unread} unread
              </span>
            )}
            <IconButton title="Refresh mail" onClick={handleRefresh}>
              <RefreshIcon className={['h-3.5 w-3.5', refreshing ? 'animate-spin' : ''].join(' ')} />
            </IconButton>
          </div>
        </div>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mail"
            aria-label={`Search ${FOLDER_LABEL[folder]}`}
            className="h-8 w-full rounded-md border border-border bg-card pl-8 pr-2.5 text-[12px] text-foreground placeholder:text-subtle focus:outline-none"
          />
        </div>
      </header>

      {status.phase === 'error' ? (
        <ListState
          icon={<AlertIcon className="h-6 w-6" />}
          title="Can't reach your relays"
          body={status.message}
          action={
            <Button size="sm" onClick={onRetry} className="mt-1">
              Try again
            </Button>
          }
        />
      ) : filtered.length > 0 ? (
        <div className="flex-1 overflow-y-auto">
          {filtered.map((email) => (
            <EmailRow
              key={email.id}
              email={email}
              read={readOf(email)}
              selected={selectedId === email.id}
            />
          ))}
        </div>
      ) : needle ? (
        <ListState
          icon={<SearchIcon className="h-6 w-6" />}
          title="No matches"
          body={`Nothing in ${FOLDER_LABEL[folder]} matches “${query.trim()}”.`}
          action={
            <Button size="sm" onClick={() => setQuery('')} className="mt-1">
              Clear search
            </Button>
          }
        />
      ) : status.phase === 'connecting' || status.decoding > 0 ? (
        <ListState
          icon={<InboxIcon className="h-6 w-6 animate-pulse" />}
          title={status.phase === 'connecting' ? 'Connecting to relays' : 'Reading your mail'}
          body={
            status.decoding > 0
              ? // Each wrap costs a signer call, so this is genuinely slow
                // behind a bunker. Naming the count makes the wait legible.
                `Decrypting ${status.decoding} ${status.decoding === 1 ? 'message' : 'messages'}. Each one is unsealed with your key.`
              : 'Looking for your mail.'
          }
        />
      ) : (
        <ListState
          icon={<InboxIcon className="h-6 w-6" />}
          title={EMPTY_COPY[folder].title}
          body={EMPTY_COPY[folder].body}
        />
      )}
    </div>
  )
}
