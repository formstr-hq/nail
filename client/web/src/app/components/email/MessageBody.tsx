import { useEffect, useMemo, useRef, useState } from 'react'
import { useThemeStore, resolveTheme } from '@/app/store/theme'
import { usePgpMessage } from '@/app/hooks/usePgpMessage'
import { setSessionPassphrase } from '@/app/lib/pgp/session'
import type { Email } from '@/app/types/mail'
import { buildEmailFrame, hasRemoteContent } from '@/app/lib/mail/emailFrame'
import { splitPlainLinks } from '@/app/lib/mail/plainLinks'
import { openExternal } from '@/app/lib/openLink'
import { Button } from '@/app/components/ui/Button'
import { PgpSignatureBadge } from './PgpSignatureBadge'

/**
 * Plaintext render used for non-HTML bodies and decrypted PGP text.
 *
 * URLs become real anchors — plaintext never went through the HTML frame, so
 * without this a link in a text-only message was inert. They carry
 * `target="_blank"` to match HTML mail's behavior, and on native the popup is
 * a no-op, so `openExternal` routes the click to the system browser instead.
 */
function PlainBody({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-foreground">
      {splitPlainLinks(text).map((segment, i) =>
        segment.href ? (
          <a
            key={i}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2"
            onClick={(e) => {
              if (openExternal(segment.href!)) e.preventDefault()
            }}
          >
            {segment.text}
          </a>
        ) : (
          segment.text
        ),
      )}
    </pre>
  )
}

export function MessageBody({ email, senderAddress }: { email: Email; senderAddress: string }) {
  const [allowRemote, setAllowRemote] = useState(false)
  const [passphraseNonce, setPassphraseNonce] = useState(0)
  const preference = useThemeStore((s) => s.preference)
  const dark = resolveTheme(preference) === 'dark'
  const observerRef = useRef<ResizeObserver | null>(null)

  const pgp = usePgpMessage(email, senderAddress, passphraseNonce)

  // A decrypted PGP/MIME envelope carries its own html part (see
  // usePgpMessage's unwrapMimeEnvelope); that's what actually renders, in
  // place of the outer message's (necessarily absent — the body was ciphertext)
  // bodyHtml.
  const effectiveHtml = pgp.kind === 'decrypted' ? pgp.html : email.bodyHtml

  // All hooks must run before any conditional return, or the hook count changes
  // across renders as `pgp.kind` resolves — React's "rendered fewer hooks than
  // expected" crash.
  const blocked = useMemo(
    () => Boolean(effectiveHtml) && hasRemoteContent(effectiveHtml!) && !allowRemote,
    [effectiveHtml, allowRemote],
  )

  useEffect(() => () => observerRef.current?.disconnect(), [])

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

    // Native has no popup support (see openLink.ts), so `<base target="_blank">`
    // is a silent no-op there and HTML links would be dead. The frame runs no
    // scripts (`allow-scripts` is off), so the click listener has to come from
    // the parent side — same-origin access is already relied on below. On the
    // web openExternal declines and the anchor opens its normal tab.
    doc.addEventListener('click', (event) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]')
      if (anchor && openExternal(anchor.getAttribute('href') ?? '')) event.preventDefault()
    })

    const fit = () => {
      iframe.style.height = `${doc.documentElement.scrollHeight}px`
    }
    fit()
    observerRef.current?.disconnect()
    observerRef.current = new ResizeObserver(fit)
    observerRef.current.observe(doc.documentElement)
  }

  // The remote-image notice + sized iframe, shared by a plain HTML body and a
  // decrypted PGP/MIME one.
  function renderHtmlFrame(html: string) {
    return (
      <>
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
          srcDoc={buildEmailFrame(html, allowRemote, dark)}
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
      </>
    )
  }

  // PGP bodies are handled before the normal HTML/plaintext render.
  if (pgp.kind === 'decrypted') {
    return (
      <div className="flex flex-col gap-3">
        <PgpSignatureBadge signature={pgp.signature} />
        {pgp.html ? renderHtmlFrame(pgp.html) : <PlainBody text={pgp.text} />}
      </div>
    )
  }
  if (pgp.kind === 'locked') {
    return (
      <div
        className={
          'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 ' +
          (pgp.wrongPassphrase
            ? 'border-destructive bg-destructive/10'
            : 'border-border bg-background/60')
        }
      >
        <p className={'flex-1 text-[11.5px] ' + (pgp.wrongPassphrase ? 'text-destructive' : 'text-muted-foreground')}>
          {pgp.wrongPassphrase ? (
            <>
              Incorrect passphrase for your{pgp.address ? <> <strong>{pgp.address}</strong></> : ''} key. Try again.
            </>
          ) : (
            <>
              This message may be encrypted to your{pgp.address ? <> <strong>{pgp.address}</strong></> : ''} key.
              Unlock it to try reading this message.
            </>
          )}
        </p>
        <Button
          size="sm"
          onClick={() => {
            const pass = window.prompt('Enter your PGP key passphrase')
            if (pass) {
              setSessionPassphrase(pgp.fingerprint, pass)
              setPassphraseNonce((n) => n + 1)
            }
          }}
        >
          {pgp.wrongPassphrase ? 'Try again' : 'Unlock'}
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

  if (!email.bodyHtml) {
    // A truly empty body would render as a blank pane that reads as "broken".
    if (!email.body.trim()) {
      return (
        <p className="text-[13px] italic leading-relaxed text-muted-foreground">
          This message has no content.
        </p>
      )
    }
    return <PlainBody text={email.body} />
  }

  return <div className="flex flex-col gap-3">{renderHtmlFrame(email.bodyHtml)}</div>
}
