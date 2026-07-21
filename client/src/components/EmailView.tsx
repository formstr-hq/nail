import { useMemo, useState } from 'react'
import { useMailStore } from '@/store/mail'
import type { Email } from '@/types/mail'
import { replyDraft, replyAllDraft, forwardDraft, type Draft } from '@/lib/mail/draft'
import { SenderProofTrace } from '@/components/ui/SenderProof'
import { Avatar } from '@/components/ui/Avatar'
import { useProfile } from '@/hooks/useProfile'
import { Button } from '@/components/ui/Button'
import { AttachmentRow } from '@/components/AttachmentRow'
import { ReplyIcon, ReplyAllIcon, ForwardIcon, InboxIcon, BackIcon } from '@/components/ui/icons'

/**
 * Remote content in HTML mail is how senders find out a message was opened.
 * The default policy allows only images already embedded in the message, so
 * opening mail never reports back; `img-src` widens to the network only when
 * the reader asks for it.
 *
 * This is a `<meta>` policy inside the frame rather than a sandbox flag
 * because sandboxing cannot express "no network, but do render the markup".
 */
function framed(html: string, allowRemote: boolean): string {
  const imgSrc = allowRemote ? "img-src data: https: http:" : "img-src data:"
  const policy = `default-src 'none'; ${imgSrc}; style-src 'unsafe-inline'; font-src data:`
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>
    html{color-scheme:light}
    body{margin:0;padding:0;font:13.5px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0b0b0c;background:transparent;word-break:break-word}
    img{max-width:100%;height:auto}
    a{color:#c24a00}
  </style></head><body>${html}</body></html>`
}

/** True when the markup asks for anything the CSP would currently block. */
function hasRemoteContent(html: string): boolean {
  return /<img[^>]+src=["']?https?:/i.test(html)
}

function MessageBody({ email }: { email: Email }) {
  const [allowRemote, setAllowRemote] = useState(false)

  const blocked = useMemo(
    () => Boolean(email.bodyHtml) && hasRemoteContent(email.bodyHtml!) && !allowRemote,
    [email.bodyHtml, allowRemote],
  )

  // Remounts the frame when the policy changes, so relaxing it actually
  // reloads the images rather than leaving the blocked render in place.
  const frameKey = `${email.id}:${allowRemote}`

  if (!email.bodyHtml) {
    return (
      <pre className="whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-foreground">
        {email.body}
      </pre>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {blocked && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-background/60 px-3 py-2">
          <p className="flex-1 text-[11.5px] text-muted-foreground">
            Images in this message are hosted elsewhere. Loading them tells the sender you
            opened it.
          </p>
          <Button size="sm" onClick={() => setAllowRemote(true)}>
            Load images
          </Button>
        </div>
      )}
      <iframe
        key={frameKey}
        srcDoc={framed(email.bodyHtml, allowRemote)}
        sandbox=""
        referrerPolicy="no-referrer"
        className="min-h-96 w-full border-0 bg-transparent"
        title={`Message: ${email.subject}`}
      />
    </div>
  )
}

interface EmailViewProps {
  onCompose: (draft: Draft) => void
  /** Every address belonging to this user, so Reply all can exclude them. */
  selfAddresses: string[]
  /** Narrow layouts show the reading pane alone; this returns to the list. */
  onBack: () => void
}

export function EmailView({ onCompose, selfAddresses, onBack }: EmailViewProps) {
  const { emails, selectedId } = useMailStore()
  const email = selectedId ? emails[selectedId] : null
  // Hook order is fixed, so this runs before the early return below; passing
  // null when nothing is open makes it a no-op.
  const senderProfile = useProfile(email?.senderPubkey ?? null)

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

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-surface-read">
      <header className="border-b border-border px-5 py-4 md:px-6 md:py-5">
        <button
          type="button"
          onClick={onBack}
          className="mb-2 flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-subtle transition-colors hover:text-primary md:hidden"
        >
          <BackIcon className="h-3 w-3" />
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
      </footer>
    </div>
  )
}
