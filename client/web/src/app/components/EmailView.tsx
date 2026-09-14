import { useMailStore } from '@/app/store/mail'
import { useMailActions } from '@/app/hooks/useMailActions'
import { useProfile } from '@/app/hooks/useProfile'
import type { Draft } from '@/app/lib/mail/draft'
import { replyDraft, replyAllDraft, forwardDraft } from '@/app/lib/mail/draft'
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
}

export function EmailView({ onCompose, selfAddresses, onBack }: EmailViewProps) {
  const { emails, selectedId, mailState, setSelected } = useMailStore()
  const email = selectedId ? emails[selectedId] : null
  const { archive, unarchive, trash, restore, deleteForever } = useMailActions()
  // Hook order is fixed, so this runs before the early return below; passing
  // null when nothing is open makes it a no-op.
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
            label={email.from.name || email.from.address}
            picture={senderProfile.picture}
            size={32}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">
              {email.from.name || email.from.address}
            </div>
            <div className="truncate font-mono text-[10.5px] text-subtle" title={email.from.address}>
              {email.from.name ? email.from.address : `to ${email.to.map((a) => a.address).join(', ')}`}
            </div>
          </div>
          <time
            dateTime={new Date(email.timestamp * 1000).toISOString()}
            className="flex-none font-mono text-[10.5px] tabular-nums text-subtle"
          >
            {date}
          </time>
        </div>

        {email.from.name && (
          <div className="truncate pt-2 font-mono text-[10.5px] text-subtle">
            to {email.to.map((a) => a.address).join(', ')}
            {email.cc?.length ? ` · cc ${email.cc.map((a) => a.address).join(', ')}` : ''}
          </div>
        )}

        <div className="pt-3">
          <SenderProofTrace proof={email.senderProof} />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-5 md:px-6">
        <div className="max-w-[68ch]">
          <MessageBody email={email} />
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

        {email.debug && <DebugPanel email={email} />}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-5 py-3 md:px-6">
        <Button variant="primary" onClick={() => onCompose(replyDraft(email))}>
          <ReplyIcon className="h-3.5 w-3.5" />
          Reply
        </Button>
        <Button onClick={() => onCompose(replyAllDraft(email, selfAddresses))}>
          <ReplyAllIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Reply all</span>
        </Button>
        <Button onClick={() => onCompose(forwardDraft(email))}>
          <ForwardIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Forward</span>
        </Button>

        <span className="flex-1" />

        {flags?.trashed ? (
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
              onClick={fileAway(flags?.archived ? unarchive : archive)}
              title={flags?.archived ? 'Move back to Inbox' : 'Archive'}
            >
              <ArchiveIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{flags?.archived ? 'Unarchive' : 'Archive'}</span>
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
