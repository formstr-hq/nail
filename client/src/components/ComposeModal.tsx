import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { useMailStore } from '@/store/mail'
import { sendMail } from '@/lib/mail/send'
import { protocolSigner } from '@/lib/nostr/protocol-signer'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'
import { isNpub, splitAddress } from '@protocol'
import { isKnownLegacyDomain } from '@/lib/nostr/nip05'
import type { ResolveContext } from '@/lib/mail/resolve'
import type { Draft } from '@/lib/mail/draft'
import { useContacts } from '@/hooks/useContacts'
import { searchContacts } from '@/lib/mail/contacts'
import { addressesMissingKeys } from '@/lib/pgp/keyring'
import { cleartextRecipients, encryptBody } from '@/lib/pgp/compose'
import { getSessionPassphrase, setSessionPassphrase } from '@/lib/pgp/session'
import { Button, IconButton } from '@/components/ui/Button'
import { XIcon, MinimizeIcon, ExpandIcon, AlertIcon, LockIcon } from '@/components/ui/icons'

interface ComposeModalProps {
  onClose: () => void
  ctx: ResolveContext
  draft?: Draft
  /** The user's own addresses, so the recipient picker never suggests them. */
  selfAddresses: string[]
  /** Registered NIP-05 aliases this account owns — the only Froms the bridge
   *  will accept for external recipients. Used to word the guard message and
   *  to keep the npub out of the bridge path. */
  ownedAliases: string[]
  // Minimized state is owned by the parent so the "Write" action can restore an
  // already-open composer instead of silently replacing its draft.
  minimized: boolean
  setMinimized: (minimized: boolean) => void
}

/** Split a comma-separated recipient string into its committed part + the token
 *  currently being typed (everything after the last comma). */
function splitRecipients(value: string): { head: string; token: string } {
  const lastComma = value.lastIndexOf(',')
  if (lastComma === -1) return { head: '', token: value.trimStart() }
  return { head: value.slice(0, lastComma + 1), token: value.slice(lastComma + 1).trimStart() }
}

/**
 * RFC 3676 §4.3 signature delimiter — "-- " on its own line. Receiving
 * clients use it to fold the signature away, so the trailing space matters.
 */
function signatureBlock(signature: string | undefined): string {
  const trimmed = signature?.trim()
  return trimmed ? `\n\n-- \n${trimmed}` : ''
}

export function ComposeModal({
  onClose,
  ctx,
  draft,
  selfAddresses,
  ownedAliases,
  minimized,
  setMinimized,
}: ComposeModalProps) {
  const { account, active } = useAccountStore()
  const { settings } = useSettingsStore()
  const inboxFilter = useMailStore((s) => s.inboxFilter)
  const setInboxFilter = useMailStore((s) => s.setInboxFilter)
  const contacts = useContacts(selfAddresses)

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

  // App-wide From, fully derived from the inbox the user is viewing (the
  // sidebar's active alias), falling back to the saved sender address, then an
  // owned alias, then the npub. Deriving it — rather than seeding a `useState`
  // once at mount — is the fix for the composer/sidebar handle mismatch:
  // `selfAddresses` (owned addresses), `settings.senderAddress`, and
  // `inboxFilter` all resolve/change *after* the composer opens, and a frozen
  // seed left the From showing a different handle than the sidebar. An explicit
  // pick writes through to `inboxFilter` (the select's onChange, silent
  // setter), so this expression tracks the user's choice too and the two never
  // disagree. It is the npub that used to silently bounce off the bridge; the
  // guard below blocks that. An alias is preferred over the npub as the bare
  // default because the npub bounces at the bridge for legacy recipients while
  // an alias works for both — an explicit npub pick (switcher → inboxFilter, or
  // saved sender) still wins via the branches above.
  const fromAddress = useMemo(() => {
    if (inboxFilter) {
      const match = selfAddresses.find((a) => a.toLowerCase() === inboxFilter)
      if (match) return match
    }
    if (settings.senderAddress) return settings.senderAddress
    if (ownedAliases.length > 0) return ownedAliases[0]
    return defaultAddress || selfAddresses[0] || ''
  }, [inboxFilter, selfAddresses, settings.senderAddress, defaultAddress, ownedAliases])
  // Selected alias first, the rest in selfAddresses order (npub next, then
  // owned aliases) — so the dropdown leads with the active sender.
  const fromOptions = useMemo(() => {
    const rest = selfAddresses.filter(
      (a) => a.toLowerCase() !== fromAddress.toLowerCase(),
    )
    return fromAddress ? [fromAddress, ...rest] : rest
  }, [selfAddresses, fromAddress])

  // An npub From is a valid sender for anything reached directly over Nostr
  // (npubs, and NIP-05 names on any nostr-native domain) but NOT for recipients
  // the bridge delivers — external email addresses, which only accept a
  // registered alias sender. Replay that rule client-side so the user gets a
  // clear message instead of a postmaster bounce. The bridge set is only known
  // for sure after resolving recipients (send.ts does that authoritatively);
  // here we pre-block only on the *definite* case — a recipient on a known
  // legacy email domain — so NIP-05 names on unfamiliar domains are never
  // falsely flagged. Anything ambiguous is left to send.ts, which surfaces its
  // own error on Send.
  const recipients = useMemo(
    () => to.split(',').map((s) => s.trim()).filter(Boolean),
    [to],
  )
  const hasLegacyRecipient = useMemo(
    () =>
      recipients.some((r) => {
        const parts = splitAddress(r)
        return (
          !!parts &&
          !ctx.localDomains.includes(parts.domain) &&
          isKnownLegacyDomain(parts.domain)
        )
      }),
    [recipients, ctx.localDomains],
  )
  const fromParts = splitAddress(fromAddress)
  const fromIsNpub = !!fromParts && isNpub(fromParts.localpart)
  const npubBlocked = fromIsNpub && hasLegacyRecipient
  const hasAlias = ownedAliases.length > 0

  // --- PGP encryption gate ---
  // Encrypt is offered only once the user holds a key AND we have a public key
  // for every recipient — a body encrypted to a missing recipient is a body
  // they can't read. `missingKeys` names the gaps so the UI can explain why the
  // toggle is off rather than just disabling it silently.
  const [encrypt, setEncrypt] = useState(false)
  const hasOwnPgpKey = Boolean(settings.pgpPublicKey && settings.pgpPrivateKey)
  const missingKeys = useMemo(
    () =>
      recipients.length
        ? addressesMissingKeys(
            { pgpKeyring: settings.pgpKeyring, pgpPublicKey: settings.pgpPublicKey, ownAddresses: selfAddresses },
            recipients,
          )
        : [],
    [recipients, settings.pgpKeyring, settings.pgpPublicKey, selfAddresses],
  )
  const canEncrypt = hasOwnPgpKey && recipients.length > 0 && missingKeys.length === 0
  // Turn the toggle off by itself the moment it stops being possible (a
  // recipient without a key was added), so a stale "on" never sends plaintext
  // while the UI still reads as encrypted.
  useEffect(() => {
    if (encrypt && !canEncrypt) setEncrypt(false)
  }, [encrypt, canEncrypt])
  // Plaintext-provider nudge: only meaningful when NOT encrypting.
  const cleartext = useMemo(
    () => (encrypt ? [] : cleartextRecipients(recipients)),
    [encrypt, recipients],
  )

  // --- recipient autocomplete over past correspondents ---
  const [recipientFocused, setRecipientFocused] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)

  const { token: recipientToken } = splitRecipients(to)
  // Addresses already on the line, so we never suggest a duplicate.
  const alreadyAdded = useMemo(
    () => new Set(to.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    [to],
  )
  const suggestions = useMemo(
    () =>
      recipientFocused && recipientToken.length >= 3
        ? searchContacts(contacts, recipientToken).filter((c) => !alreadyAdded.has(c.key))
        : [],
    [recipientFocused, contacts, recipientToken, alreadyAdded],
  )
  const showSuggestions = suggestions.length > 0
  const activeIndex = Math.min(activeSuggestion, suggestions.length - 1)

  function applySuggestion(address: string) {
    const { head } = splitRecipients(to)
    setTo(`${head}${head ? ' ' : ''}${address}, `)
    setActiveSuggestion(0)
    toRef.current?.focus()
  }

  function onRecipientKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showSuggestions) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSuggestion((i) => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggestion((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      applySuggestion(suggestions[activeIndex].address)
    } else if (e.key === 'Escape') {
      // Dismiss the dropdown without letting the composer's own Escape close it.
      e.stopPropagation()
      setRecipientFocused(false)
    }
  }

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
    const toList = to.split(',').map((s) => s.trim()).filter(Boolean)
    setSending(true)
    setError('')
    try {
      // Encrypt the body in place when the toggle is on: the inline-PGP block
      // replaces the plaintext, so every wrap (each recipient plus the Sent
      // self-copy) carries the armored body and send.ts needs no PGP awareness.
      let outgoingBody = body
      if (encrypt) {
        let passphrase = settings.pgpPassphraseProtected ? getSessionPassphrase() ?? undefined : undefined
        if (settings.pgpPassphraseProtected && !passphrase) {
          const entered = window.prompt('Enter your PGP key passphrase to sign this message')
          if (!entered) {
            setError('A passphrase is required to sign and send an encrypted message.')
            setSending(false)
            return
          }
          setSessionPassphrase(entered)
          passphrase = entered
        }
        outgoingBody = await encryptBody({
          body,
          recipients: toList,
          settings,
          ownAddresses: selfAddresses,
          passphrase,
        })
      }

      await sendMail({
        from: { address: fromAddress },
        senderPubkey: account.pubkey,
        to: toList,
        subject,
        body: outgoingBody,
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

  const canSend = Boolean(to.trim() && subject.trim()) && !sending && !npubBlocked

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
        className="pointer-events-auto safe-bottom flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-2xl md:h-[32rem] md:max-w-xl md:rounded-xl"
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
          <div className="relative">
            <label className="flex items-center gap-2 px-3.5">
              {/* Wide enough for the longest label, so both inputs share one gutter. */}
              <span className="eyebrow w-16 flex-none">To</span>
              <input
                ref={toRef}
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  setActiveSuggestion(0)
                }}
                onFocus={() => setRecipientFocused(true)}
                // Delay so a suggestion click registers before the list unmounts.
                onBlur={() => setTimeout(() => setRecipientFocused(false), 120)}
                onKeyDown={onRecipientKeyDown}
                placeholder="npub, name@domain, or an email address"
                autoComplete="off"
                role="combobox"
                aria-expanded={showSuggestions}
                aria-autocomplete="list"
                className="h-9 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
              />
            </label>
            {showSuggestions && (
              <ul className="absolute left-2 right-2 top-full z-20 max-h-56 overflow-y-auto rounded-md border border-border bg-card py-1 shadow-lg">
                {suggestions.map((c, i) => (
                  <li key={c.key}>
                    <button
                      type="button"
                      // Keep focus on the input so onBlur doesn't fire before this click.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applySuggestion(c.address)}
                      className={[
                        'flex w-full items-baseline gap-2 px-3 py-1.5 text-left',
                        i === activeIndex ? 'bg-accent' : 'hover:bg-accent/60',
                      ].join(' ')}
                    >
                      {c.name && (
                        <span className="flex-none text-[12.5px] font-medium text-foreground">
                          {c.name}
                        </span>
                      )}
                      <span className="truncate font-mono text-[11px] text-subtle">{c.address}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
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

        {npubBlocked && (
          <div className="flex items-start gap-2 border-t border-border bg-accent px-3.5 py-2">
            <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-muted-foreground" />
            <p className="text-[11.5px] leading-relaxed text-foreground">
              {hasAlias
                ? 'External email addresses are delivered through the bridge, which only accepts registered alias senders — your npub can’t reach them. (Your npub still works fine for any recipient reached directly over Nostr: npubs and NIP-05 names.) Pick one of your aliases in From, or remove the external recipient.'
                : 'External email addresses are delivered through the bridge, which only accepts registered alias senders — your npub can’t reach them. (Your npub still works fine for any recipient reached directly over Nostr: npubs and NIP-05 names.) Buy an alias to send to external email, or remove the external recipient.'}
            </p>
          </div>
        )}

        {encrypt && (
          <div className="flex items-start gap-2 border-t border-border bg-background/60 px-3.5 py-2">
            <LockIcon className="mt-px h-3.5 w-3.5 flex-none text-muted-foreground" />
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Encrypted with PGP. The subject line is <em>not</em> encrypted.
            </p>
          </div>
        )}

        {cleartext.length > 0 && (
          <div className="flex items-start gap-2 border-t border-border bg-background/60 px-3.5 py-2">
            <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-muted-foreground" />
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              {cleartext.join(', ')} can read this message on their servers.
              {canEncrypt
                ? ' Turn on Encrypt to protect it.'
                : hasOwnPgpKey
                  ? ' Import their PGP key to encrypt.'
                  : ''}
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">From</div>
            <select
              value={fromAddress}
              // The closed select shows the selected address verbatim, and an
              // npub (npub1…@domain) is far wider than a phone's From column —
              // without truncation it overflows the box and draws over the Send
              // button. truncate clips it with an ellipsis in Chromium's WebView
              // (Capacitor); the dropdown options below still show the full
              // address, and title carries it for long-press/hover.
              title={fromAddress}
              onChange={(e) => {
                // The From is derived from inboxFilter, so a pick is expressed by
                // updating the filter — which mirrors the choice into the sidebar
                // highlight (app-wide) without clearing the open message.
                setInboxFilter(e.target.value, true)
              }}
              className="mt-0.5 w-full max-w-full truncate bg-transparent font-mono text-[10.5px] text-foreground focus:outline-none"
            >
              {fromOptions.map((a) => (
                <option key={a} value={a} className="font-mono">
                  {a}
                </option>
              ))}
            </select>
            {/* No purchased alias yet: the npub works for mailstr.app mail, but
                anything external needs an alias. Nudge to the landing, where
                aliases are bought (the mail app lives at /mails, so "/" is the
                signup screen). Opens in a tab so the draft is preserved. */}
            {!hasAlias && (
              <a
                href="/"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-[10.5px] text-muted-foreground underline hover:text-foreground"
              >
                Get an alias →
              </a>
            )}
          </div>
          {hasOwnPgpKey && (
            <button
              type="button"
              // Enabled only when every recipient has a key; the title carries
              // the reason when it's not, so the disabled state is never mute.
              disabled={!canEncrypt}
              onClick={() => setEncrypt((v) => !v)}
              title={
                canEncrypt
                  ? encrypt
                    ? 'Encryption on — click to turn off'
                    : 'Encrypt this message with PGP'
                  : missingKeys.length
                    ? `No PGP key for ${missingKeys.join(', ')} — import one to encrypt`
                    : 'Add a recipient to encrypt'
              }
              className={[
                'flex flex-none items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                encrypt
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent',
                'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
              ].join(' ')}
            >
              <LockIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{encrypt ? 'Encrypted' : 'Encrypt'}</span>
            </button>
          )}
          <Button variant="primary" onClick={handleSend} disabled={!canSend}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}
