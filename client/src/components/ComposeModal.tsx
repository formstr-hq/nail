import { useEffect, useRef, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { sendMail } from '@/lib/mail/send'
import { protocolSigner } from '@/lib/nostr/protocol-signer'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'
import type { ResolveContext } from '@/lib/mail/resolve'
import type { Draft } from '@/lib/mail/draft'
import { Button, IconButton } from '@/components/ui/Button'
import { XIcon, MinimizeIcon, ExpandIcon, AlertIcon } from '@/components/ui/icons'

interface ComposeModalProps {
  onClose: () => void
  ctx: ResolveContext
  draft?: Draft
  // Minimized state is owned by the parent so the "Write" action can restore an
  // already-open composer instead of silently replacing its draft.
  minimized: boolean
  setMinimized: (minimized: boolean) => void
}

/**
 * RFC 3676 §4.3 signature delimiter — "-- " on its own line. Receiving
 * clients use it to fold the signature away, so the trailing space matters.
 */
function signatureBlock(signature: string | undefined): string {
  const trimmed = signature?.trim()
  return trimmed ? `\n\n-- \n${trimmed}` : ''
}

export function ComposeModal({ onClose, ctx, draft, minimized, setMinimized }: ComposeModalProps) {
  const { account, active } = useAccountStore()
  const { settings } = useSettingsStore()

  // The signature is a stored setting that nothing used to apply. Prefilling
  // it rather than appending at send time means the sender can see and edit
  // what goes out, instead of it appearing only in the recipient's copy.
  const [to, setTo] = useState(draft?.to ?? '')
  const [subject, setSubject] = useState(draft?.subject ?? '')
  const [body, setBody] = useState(
    () => `${signatureBlock(settings.signature)}${draft?.body ?? ''}`,
  )
  // The prefilled baseline the body is measured against for dirtiness. Held in
  // a ref, not recomputed each render: the signature setting loads async, and
  // recomputing would let a late-arriving signature shift the baseline out from
  // under an untouched body — which is what made the composer read as dirty and
  // sent Close to the discard prompt instead of closing.
  const initialBodyRef = useRef(body)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const toRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const defaultAddress = account ? `${account.npub}@${BRIDGE_DOMAIN}` : ''
  const fromAddress = settings.senderAddress || defaultAddress

  // A reply already knows its recipient, so the cursor belongs in the body.
  useEffect(() => {
    if (draft?.to) bodyRef.current?.focus()
    else toRef.current?.focus()
  }, [draft?.to])

  // The signature loads after mount, so fold it into the body once it arrives —
  // but only while the body still matches the baseline, so this never clobbers
  // text the user has typed. Moving the baseline in lockstep keeps `isDirty`
  // honest.
  useEffect(() => {
    const nextInitial = `${signatureBlock(settings.signature)}${draft?.body ?? ''}`
    if (nextInitial === initialBodyRef.current) return
    if (body === initialBodyRef.current) setBody(nextInitial)
    initialBodyRef.current = nextInitial
  }, [settings.signature, draft?.body, body])

  // Anything the user typed beyond what was prefilled.
  const isDirty =
    to !== (draft?.to ?? '') ||
    subject !== (draft?.subject ?? '') ||
    body !== initialBodyRef.current

  function requestClose() {
    if (isDirty && !sending) setConfirmingDiscard(true)
    else onClose()
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Escape backs out of the confirmation first, so it can never be the
      // key that discards a draft.
      if (confirmingDiscard) setConfirmingDiscard(false)
      else if (minimized) setMinimized(false)
      else requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // On desktop the composer is a docked panel that leaves the rest of the app
  // usable, so clicking away should tuck it out of the way rather than nag —
  // a draft is never lost, just minimized. On phones the panel is a full sheet
  // whose backdrop is the way out, so that path (below) still closes.
  useEffect(() => {
    if (minimized) return
    function onPointerDown(e: MouseEvent) {
      if (!window.matchMedia('(min-width: 768px)').matches) return
      if (panelRef.current?.contains(e.target as Node)) return
      setMinimized(true)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [minimized])

  async function handleSend() {
    if (!account || !active || !to.trim() || !subject.trim()) return
    setSending(true)
    setError('')
    try {
      await sendMail({
        from: { address: fromAddress },
        senderPubkey: account.pubkey,
        to: to
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        subject,
        body,
        inReplyTo: draft?.inReplyTo,
        references: draft?.references,
        ctx,
        signer: protocolSigner(active),
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  if (minimized) {
    return (
      <div className="fixed bottom-0 right-4 z-50 md:right-6">
        <button
          type="button"
          onClick={() => setMinimized(false)}
          className="flex w-64 items-center gap-2 rounded-t-lg border border-b-0 border-border bg-card px-3 py-2 text-left shadow-lg transition-colors hover:bg-accent"
        >
          <span className="flex-1 truncate text-[12.5px] font-medium text-foreground">
            {subject.trim() || 'New message'}
          </span>
          <ExpandIcon className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        </button>
      </div>
    )
  }

  const canSend = Boolean(to.trim() && subject.trim()) && !sending

  return (
    <div
      // Full-screen sheet on phones; a docked panel from md up. On desktop the
      // wrapper lets clicks through (`md:pointer-events-none`) so the rest of
      // the app stays usable while composing — the outside-click-to-minimize
      // effect above handles tucking the panel away. On phones the backdrop is
      // solid and is the way out of the sheet.
      className="pointer-events-auto fixed inset-0 z-50 flex flex-col justify-end bg-foreground/20 md:pointer-events-none md:items-end md:bg-transparent md:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="New message"
        className="pointer-events-auto flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-2xl md:h-[32rem] md:max-w-xl md:rounded-xl"
      >
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          <span className="eyebrow flex-1">{draft?.inReplyTo ? 'Reply' : 'New message'}</span>
          <IconButton title="Minimize" onClick={() => setMinimized(true)}>
            <MinimizeIcon className="h-4 w-4" />
          </IconButton>
          <IconButton title="Close" onClick={requestClose}>
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>

        {confirmingDiscard && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-accent px-3 py-2">
            <p className="flex-1 text-[12px] text-foreground">Discard this draft?</p>
            <Button size="sm" onClick={() => setConfirmingDiscard(false)}>
              Keep writing
            </Button>
            <Button size="sm" variant="danger" onClick={onClose}>
              Discard
            </Button>
          </div>
        )}

        <div className="flex flex-col divide-y divide-border border-b border-border">
          <label className="flex items-center gap-2 px-3.5">
            {/* Wide enough for the longest label, so both inputs share one gutter. */}
            <span className="eyebrow w-16 flex-none">To</span>
            <input
              ref={toRef}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="npub, name@domain, or an email address"
              className="h-9 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2 px-3.5">
            {/* Wide enough for the longest label, so both inputs share one gutter. */}
            <span className="eyebrow w-16 flex-none">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What is this about?"
              className="h-9 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
            />
          </label>
        </div>

        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your message"
          className="min-h-[8rem] flex-1 resize-none bg-transparent px-3.5 py-3 text-[13.5px] leading-relaxed text-foreground placeholder:text-subtle focus:outline-none"
        />

        {error && (
          <div className="flex items-start gap-2 border-t border-border bg-destructive/10 px-3.5 py-2">
            <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
            <p className="text-[11.5px] leading-relaxed text-destructive">{error}</p>
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">From</div>
            <div className="truncate font-mono text-[10.5px] text-subtle" title={fromAddress}>
              {fromAddress}
            </div>
          </div>
          <Button variant="primary" onClick={handleSend} disabled={!canSend}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}
