import { useEffect, useMemo, useRef, useState } from 'react'
import { useMailStore } from '@/store/mail'
import { useMailActions } from '@/hooks/useMailActions'
import { useThemeStore, resolveTheme } from '@/store/theme'
import { useDevStore } from '@/store/dev'
import { usePgpMessage } from '@/hooks/usePgpMessage'
import { setSessionPassphrase } from '@/lib/pgp/session'
import type { SignatureState } from '@/lib/pgp/openpgp'
import type { Email } from '@/types/mail'
import { replyDraft, replyAllDraft, forwardDraft, type Draft } from '@/lib/mail/draft'
import { SenderProofTrace } from '@/components/ui/SenderProof'
import { Avatar } from '@/components/ui/Avatar'
import { useProfile } from '@/hooks/useProfile'
import { Button } from '@/components/ui/Button'
import { AttachmentRow } from '@/components/AttachmentRow'
import { buildEmailFrame, hasRemoteContent } from '@/lib/mail/emailFrame'
import {
  ReplyIcon,
  ReplyAllIcon,
  ForwardIcon,
  InboxIcon,
  BackIcon,
  ArchiveIcon,
  TrashIcon,
  LockIcon,
} from '@/components/ui/icons'

/**
 * The one-line signature verdict shown above a decrypted PGP message. Honest
 * and specific — "signed by a key you don't have" is not "verified", and a
 * failed signature is a loud warning, never a quiet pass. Mirrors SenderProof.
 */
function PgpSignatureBadge({ signature }: { signature: SignatureState }) {
  const map = {
    valid: { text: 'Signature verified', cls: 'border-border bg-background/60 text-muted-foreground' },
    'unknown-key': {
      text: 'Signed, but by a key you don’t have — import it to verify',
      cls: 'border-border bg-background/60 text-muted-foreground',
    },
    invalid: {
      text: 'BAD SIGNATURE — this message failed verification',
      cls: 'border-destructive bg-destructive/10 text-destructive',
    },
    none: { text: 'Not signed', cls: 'border-border bg-background/60 text-subtle' },
  }[signature.status]
  return (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] ${map.cls}`}>
      <LockIcon className="h-3 w-3 flex-none" />
      <span>Decrypted · {map.text}</span>
    </div>
  )
}

/** Plaintext render used for non-HTML bodies and decrypted PGP text. */
function PlainBody({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-foreground">
      {text}
    </pre>
  )
}

function MessageBody({ email }: { email: Email }) {
  const [allowRemote, setAllowRemote] = useState(false)
  const [passphraseNonce, setPassphraseNonce] = useState(0)
  const preference = useThemeStore((s) => s.preference)
  const dark = resolveTheme(preference) === 'dark'
  const observerRef = useRef<ResizeObserver | null>(null)

  const pgp = usePgpMessage(email, passphraseNonce)

  // PGP bodies are handled before the normal HTML/plaintext render: a decrypted
  // message is plaintext, and the locked/no-key/error states each get an honest
  // notice rather than dumping the armored blob as if it were the message.
  if (pgp.kind === 'decrypted') {
    return (
      <div className="flex flex-col gap-3">
        <PgpSignatureBadge signature={pgp.signature} />
        <PlainBody text={pgp.text} />
      </div>
    )
  }
  if (pgp.kind === 'locked') {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-background/60 px-3 py-2">
        <p className="flex-1 text-[11.5px] text-muted-foreground">
          This message is encrypted. Unlock your PGP key to read it.
        </p>
        <Button
          size="sm"
          onClick={() => {
            const pass = window.prompt('Enter your PGP key passphrase')
            if (pass) {
              // Cache for the session, then re-run the decrypt.
              setSessionPassphrase(pass)
              setPassphraseNonce((n) => n + 1)
            }
          }}
        >
          Unlock
        </Button>
      </div>
    )
  }
  if (pgp.kind === 'no-key') {
    return (
      <div className="flex flex-col gap-2">
        <div className="rounded-md border border-border bg-background/60 px-3 py-2 text-[11.5px] text-muted-foreground">
          This message is PGP-encrypted, but not to a key you hold — it can’t be decrypted here.
        </div>
        <PlainBody text={email.body} />
      </div>
    )
  }
  if (pgp.kind === 'error') {
    return (
      <div className="flex flex-col gap-2">
        <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
          Could not decrypt this PGP message: {pgp.reason}
        </div>
        <PlainBody text={email.body} />
      </div>
    )
  }

  const blocked = useMemo(
    () => Boolean(email.bodyHtml) && hasRemoteContent(email.bodyHtml!) && !allowRemote,
    [email.bodyHtml, allowRemote],
  )

  // Remounts the frame when the policy or theme changes, so relaxing the CSP
  // reloads the images and a theme switch re-renders in the new palette rather
  // than leaving the old render in place.
  const frameKey = `${email.id}:${allowRemote}:${dark ? 'd' : 'l'}`

  // Size the frame to its own content so the message scrolls with the reading
  // pane instead of trapping a second scrollbar inside a fixed-height box. This
  // reads the framed document directly (allow-same-origin), and a ResizeObserver
  // keeps it in step as images and late layout settle after load.
  function fitToContent(e: React.SyntheticEvent<HTMLIFrameElement>) {
    const iframe = e.currentTarget
    const doc = iframe.contentDocument
    if (!doc) return
    const fit = () => {
      iframe.style.height = `${doc.documentElement.scrollHeight}px`
    }
    fit()
    observerRef.current?.disconnect()
    observerRef.current = new ResizeObserver(fit)
    observerRef.current.observe(doc.documentElement)
  }

  useEffect(() => () => observerRef.current?.disconnect(), [])

  if (!email.bodyHtml) {
    // A truly empty body would render as a blank pane that reads as "broken".
    // Say so plainly instead — the decode already recovers content from
    // non-MIME messages (see receive.ts), so reaching here means it really is
    // empty.
    if (!email.body.trim()) {
      return (
        <p className="text-[13px] italic leading-relaxed text-muted-foreground">
          This message has no content.
        </p>
      )
    }
    return <PlainBody text={email.body} />
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
        srcDoc={buildEmailFrame(email.bodyHtml, allowRemote, dark)}
        // Scripts stay off (no `allow-scripts`) and the CSP blocks them too, so
        // same-origin can't be turned against us — it only lets us measure the
        // document for auto-height. Popups let `target="_blank"` links open, and
        // escaping the sandbox lets them land as ordinary pages.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        onLoad={fitToContent}
        scrolling="no"
        className="w-full border-0 bg-transparent"
        title={`Message: ${email.subject}`}
      />
    </div>
  )
}

/**
 * A collapsed disclosure showing the raw decoded rumor — the ground truth for
 * "why does this message look like this?". Kind, sealing key, tags and the
 * exact content as it arrived, before any RFC 2822 interpretation. Collapsed by
 * default so it never intrudes on normal reading.
 */
function DebugPanel({ email }: { email: Email }) {
  const debugPanel = useDevStore((s) => s.debugPanel)
  const [copied, setCopied] = useState(false)
  if (!debugPanel) return null
  const debug = email.debug!
  const json = JSON.stringify(
    { ...debug, senderProof: email.senderProof, giftWrapId: email.id },
    null,
    2,
  )

  async function copy() {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard blocked (insecure origin / permission) — the JSON is still
      // on screen to select by hand, so there is nothing to recover here.
    }
  }

  return (
    <details className="mt-8 rounded-md border border-border bg-background/40">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-subtle">
        Debug · rumor event
        <span className="font-sans lowercase tracking-normal text-muted-foreground">
          kind {debug.rumor.kind} · proof {email.senderProof}
        </span>
      </summary>
      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={copy}
          className="mb-2 rounded border border-input bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-muted-foreground">
          {json}
        </pre>
      </div>
    </details>
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
  const { emails, selectedId, mailState, setSelected } = useMailStore()
  const email = selectedId ? emails[selectedId] : null
  const { archive, unarchive, trash, restore } = useMailActions()
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
          <Button onClick={fileAway(restore)} title="Move back to Inbox">
            <InboxIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Restore</span>
          </Button>
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
