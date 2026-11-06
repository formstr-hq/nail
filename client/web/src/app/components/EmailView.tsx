import { useMailStore } from '@/app/store/mail'
import { useSettingsStore } from '@/app/store/settings'
import { foldersOf, matchesMatch, resolveFolder, resolveLabels, labelsOf } from '@/app/lib/mail/folders'
import { useMailActions } from '@/app/hooks/useMailActions'
import { useProfile } from '@/app/hooks/useProfile'
import { useSenderIdentity } from '@/app/hooks/useSenderIdentity'
import type { Draft } from '@/app/lib/mail/draft'
import { replyDraft, replyAllDraft, forwardDraft } from '@/app/lib/mail/draft'
import type { Email } from '@/app/types/mail'
import { SenderProofTrace } from '@/app/components/ui/SenderProof'
import { Avatar } from '@/app/components/ui/Avatar'
import { Button } from '@/app/components/ui/Button'
import { ConfirmButton } from '@/app/components/ui/ConfirmButton'
import { AttachmentRow } from '@/app/components/AttachmentRow'
import { MessageBody } from './email/MessageBody'
import { DebugPanel } from './email/DebugPanel'
import {
  ReplyIcon,
  ReplyAllIcon,
  ForwardIcon,
  InboxIcon,
  BackIcon,
  ArchiveIcon,
  TrashIcon,
} from '@/app/components/ui/icons'

interface EmailViewProps {
  onCompose: (draft: Draft) => void
  /** Every address belonging to this user, so Reply all can exclude them. */
  selfAddresses: string[]
  /** Narrow layouts show the reading pane alone; this returns to the list. */
  onBack: () => void
  /** Replay a partially received chunked message from the relays. */
  onRetryPartial: (email: Email) => void
}

export function EmailView({ onCompose, selfAddresses, onBack, onRetryPartial }: EmailViewProps) {
  const { emails, selectedId, mailState, setSelected } = useMailStore()
  const email = selectedId ? emails[selectedId] : null
  const { archive, unarchive, trash, restore, deleteForever, notSpam, toggleLabel } = useMailActions()
  const settings = useSettingsStore((s) => s.settings)
  const folders = foldersOf(settings)
  const labelDefs = labelsOf(settings)
  // Live sender identity for the open message. Derived, never read off the
  // stored email: a bridge resolution landing after decode must repaint this
  // header, and a spoofed header must never be shown as the sender.
  const { proof, from } = useSenderIdentity(email)
  // The profile here labels the sealing KEY (avatar/picture), so it must key
  // off senderPubkey and not the possibly-spoofed header address.
  const senderProfile = useProfile(email?.senderPubkey ?? null)

  // Filing a mail from the reading pane removes it from the folder in view, so
  // return to the list rather than leaving a now-misfiled message open.
  const fileAway = (action: (id: string) => void) => () => {
    if (!email) return
    action(email.id)
    setSelected(null)
  }

  if (!email) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-surface-read px-8 text-center">
        <InboxIcon className="h-7 w-7 text-subtle" />
        <p className="text-[13px] font-semibold text-foreground">Nothing open</p>
        <p className="max-w-[36ch] text-[11.5px] leading-relaxed text-muted-foreground">
          Pick a message from the list to read it.
        </p>
      </div>
    )
  }

  const date = new Date(email.timestamp * 1000).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  const flags = mailState[email.id]
  const folderId = resolveFolder(email, flags, folders)
  const labels = resolveLabels(email, flags, labelDefs)

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-surface-read">
      <header className="border-b border-border px-5 py-4 md:px-6 md:py-5">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 mb-1 flex items-center gap-1.5 rounded-md px-2 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-subtle transition-colors hover:bg-accent hover:text-primary md:hidden"
        >
          <BackIcon className="h-3.5 w-3.5" />
          All messages
        </button>

        <h1 className="text-balance text-lg font-semibold leading-tight tracking-tight text-foreground md:text-xl">
          {email.subject}
        </h1>

        <div className="flex items-center gap-2.5 pt-3">
          <Avatar
            label={from.name || from.address}
            picture={senderProfile.picture}
            size={32}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">
              {from.name || from.address}
            </div>
            <div className="truncate font-mono text-[10.5px] text-subtle" title={from.address}>
              {from.name ? from.address : `to ${email.to.map((a) => a.address).join(', ')}`}
            </div>
          </div>
          <time
            dateTime={new Date(email.timestamp * 1000).toISOString()}
            className="flex-none font-mono text-[10.5px] tabular-nums text-subtle"
          >
            {date}
          </time>
        </div>

        {from.name && (
          <div className="truncate pt-2 font-mono text-[10.5px] text-subtle">
            to {email.to.map((a) => a.address).join(', ')}
            {email.cc?.length ? ` · cc ${email.cc.map((a) => a.address).join(', ')}` : ''}
          </div>
        )}

        <div className="pt-3">
          <SenderProofTrace proof={proof} />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-5 md:px-6">
        {email.partial && (
          <div className="mb-4 flex max-w-[68ch] items-center justify-between gap-3 rounded-md border border-border bg-accent px-3 py-2">
            <span className="text-[12px] leading-snug text-foreground">
              Receiving message… {email.partial.have}/{email.partial.total} parts
              {email.partial.headerless
                ? ' · waiting for the first part'
                : email.partial.missing.length > 0
                  ? ` · missing ${email.partial.missing.map((i) => i + 1).join(', ')}`
                  : ''}
            </span>
            <Button
              variant="secondary"
              onClick={() => onRetryPartial(email)}
              className="flex-none"
            >
              Retry
            </Button>
          </div>
        )}

        {folderId === 'spam' && (
          <div className="mb-4 flex max-w-[68ch] items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
            <span className="text-[12px] leading-snug text-destructive">
              The receiving server marked this message as spam.
            </span>
            <Button
              variant="secondary"
              onClick={() => notSpam(email.id)}
              className="flex-none"
            >
              Not spam
            </Button>
          </div>
        )}

        {labels.length > 0 && (
          <div className="mb-3 flex max-w-[68ch] flex-wrap gap-1.5">
            {labels.map((id) => {
              const def = labelDefs.find((l) => l.id === id)
              return (
                <span
                  key={id}
                  className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
                >
                  {def?.name ?? id}
                </span>
              )
            })}
          </div>
        )}

        <div className="max-w-[68ch]">
          <MessageBody email={email} senderAddress={from.address} />
        </div>

        {email.attachments.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-6">
            <div className="eyebrow">
              {email.attachments.length}{' '}
              {email.attachments.length === 1 ? 'attachment' : 'attachments'}
            </div>
            {email.attachments.map((a, i) => (
              <AttachmentRow key={`${a.filename}-${i}`} attachment={a} />
            ))}
          </div>
        )}

        {email.debug && <DebugPanel email={email} proof={proof} />}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-5 py-3 md:px-6">
        {/* The effective sender, not the raw header: a spoofed From must never
            become the reply's recipient or be quoted as the author. `self`
            pins the From to the mailbox this message was delivered to. */}
        <Button
          variant="primary"
          disabled={Boolean(email.partial)}
          title={email.partial ? 'Wait for the message to finish arriving' : undefined}
          onClick={() => onCompose(replyDraft(email, from, selfAddresses))}
        >
          <ReplyIcon className="h-3.5 w-3.5" />
          Reply
        </Button>
        <Button
          disabled={Boolean(email.partial)}
          title={email.partial ? 'Wait for the message to finish arriving' : undefined}
          onClick={() => onCompose(replyAllDraft(email, selfAddresses, from))}
        >
          <ReplyAllIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Reply all</span>
        </Button>
        <Button
          disabled={Boolean(email.partial)}
          title={email.partial ? 'Wait for the message to finish arriving' : undefined}
          onClick={() => onCompose(forwardDraft(email))}
        >
          <ForwardIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Forward</span>
        </Button>

        <span className="flex-1" />

        {labelDefs.length > 0 && (
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-md border border-input px-3 py-1.5 text-[13px] text-foreground hover:bg-accent [&::-webkit-details-marker]:hidden">
              Labels
            </summary>
            <div className="absolute bottom-full right-0 z-10 mb-2 w-56 rounded-md border border-border bg-card p-2 shadow-lg">
              {labelDefs.map((label) => {
                const matched = label.match ? matchesMatch(label.match, email) : false
                const explicit = !!flags?.labels?.includes(label.id)
                return (
                  <label
                    key={label.id}
                    className="flex items-center gap-2 rounded px-1 py-1 text-[12px] text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={explicit || matched}
                      disabled={matched}
                      onChange={() => toggleLabel(email.id, label.id)}
                    />
                    <span>{label.name}</span>
                    {matched && (
                      <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.08em] text-subtle">
                        rule
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          </details>
        )}

        {flags?.folder === 'trash' ? (
          <>
            <Button onClick={fileAway(restore)} title="Move back to Inbox">
              <InboxIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Restore</span>
            </Button>
            <ConfirmButton
              label="Delete forever"
              confirmLabel="Really delete?"
              title="Permanently delete from relays and this device"
              onConfirm={fileAway(deleteForever)}
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </ConfirmButton>
          </>
        ) : (
          <>
            <Button
              onClick={fileAway(flags?.folder === 'archive' ? unarchive : archive)}
              title={flags?.folder === 'archive' ? 'Move back to Inbox' : 'Archive'}
            >
              <ArchiveIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{flags?.folder === 'archive' ? 'Unarchive' : 'Archive'}</span>
            </Button>
            <Button onClick={fileAway(trash)} title="Move to Trash">
              <TrashIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          </>
        )}
      </footer>
    </div>
  )
}
