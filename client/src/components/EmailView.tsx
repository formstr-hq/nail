import { useEffect, useMemo, useRef, useState } from 'react'
import { useMailStore } from '@/store/mail'
import { useMailActions } from '@/hooks/useMailActions'
import { useThemeStore, resolveTheme } from '@/store/theme'
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
 * Remote content in HTML mail is how senders find out a message was opened.
 * The default policy allows only images already embedded in the message, so
 * opening mail never reports back; `img-src` widens to the network only when
 * the reader asks for it.
 *
 * This is a `<meta>` policy inside the frame rather than a sandbox flag
 * because sandboxing cannot express "no network, but do render the markup".
 */
function framed(html: string, allowRemote: boolean, dark: boolean): string {
  const imgSrc = allowRemote ? "img-src data: https: http:" : "img-src data:"
  const policy = `default-src 'none'; ${imgSrc}; style-src 'unsafe-inline'; font-src data:`
  // Follow the app's theme. Background stays transparent so it inherits the
  // reading pane and messages that set their own colours are left alone; only
  // the defaults (text, links, native controls) track light/dark.
  const fg = dark ? '#e6e6e6' : '#0b0b0c'
  // Links stay ink and lean on the underline for affordance — colour is
  // functional here too, and a coloured link in arbitrary mail would compete
  // with the app's own meaning for colour. Underline carries the "link".
  const link = fg
  // `<base target="_blank">` sends every link to a new tab instead of replacing
  // the frame's own document; the sandbox flags below are what let that popup
  // actually open and land as a normal (un-sandboxed) page.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>
    html{color-scheme:${dark ? 'dark' : 'light'}}
    body{margin:0;padding:0;font:13.5px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${fg};background:transparent;word-break:break-word}
    img{max-width:100%;height:auto}
    a{color:${link}}
  </style></head><body>${html}</body></html>`
}

/** True when the markup asks for anything the CSP would currently block. */
function hasRemoteContent(html: string): boolean {
  return /<img[^>]+src=["']?https?:/i.test(html)
}

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

export function MessageBody({ email }: { email: Email }) {
  const [allowRemote, setAllowRemote] = useState(false)
  const [passphraseNonce, setPassphraseNonce] = useState(0)
  const preference = useThemeStore((s) => s.preference)
  const dark = resolveTheme(preference) === 'dark'
  const observerRef = useRef<ResizeObserver | null>(null)

  const pgp = usePgpMessage(email, passphraseNonce)

  // Every hook must run before the conditional PGP returns below. usePgpMessage
  // starts at 'none' and flips to 'decrypted'/'locked'/… after the async
  // decrypt, so a hook placed after those returns would run on the first render
  // but be skipped on the re-render — "rendered fewer hooks than expected".
  const blocked = useMemo(
    () => Boolean(email.bodyHtml) && hasRemoteContent(email.bodyHtml!) && !allowRemote,
    [email.bodyHtml, allowRemote],
  )
  useEffect(() => () => observerRef.current?.disconnect(), [])

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
              // Cache against the specific alias key this message needs, then
              // re-run the decrypt.
              setSessionPassphrase(pgp.fingerprint, pass)
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

  if (!email.bodyHtml) {
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
        srcDoc={framed(email.bodyHtml, allowRemote, dark)}
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
