import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useSettingsStore } from '@/app/store/settings'
import { useMailStore } from '@/app/store/mail'
import { sendMail, isUnregisteredSenderError } from '@/app/lib/mail/send'
import { protocolSigner } from '@/app/lib/nostr/protocol-signer'
import {
  signatureBlock,
  parseRecipients,
  defaultNpubAddress,
  deriveFromAddress,
  deriveFromOptions,
  hasKnownLegacyRecipient,
  isNpubSender,
} from '@/app/lib/mail/composeFields'
import type { ResolveContext } from '@/app/lib/mail/resolve'
import type { Draft } from '@/app/lib/mail/draft'
import { useContacts } from '@/app/hooks/useContacts'
import { useComposerEncryption, noEncryptReason } from '@/app/hooks/compose/useComposerEncryption'
import { useRecipientAutocomplete } from '@/app/hooks/compose/useRecipientAutocomplete'
import { ownKeypairFor } from '@/app/lib/pgp/keyring'
import { encryptBody } from '@/app/lib/pgp/compose'
import { getSessionPassphrase, setSessionPassphrase } from '@/app/lib/pgp/session'
import { ComposerMinimized, ComposerHeader, DiscardBanner } from '@/app/components/compose/ComposerChrome'
import { RecipientField, SubjectField } from '@/app/components/compose/RecipientField'
import {
  ErrorBanner,
  NpubGuardBanner,
  DiscoveryBanner,
  EncryptedBanner,
  AliasFix,
  BridgeUnavailableBanner,
} from '@/app/components/compose/StatusBanners'
import { ComposerFooter } from '@/app/components/compose/ComposerFooter'

interface ComposeModalProps {
  onClose: () => void
  ctx: ResolveContext
  /** Non-null when the outbound bridge failed to resolve — external recipients
   *  cannot be delivered this session; surfaced instead of only logged (D4). */
  bridgeError?: string | null
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
  /** Opens Settings on the Encryption tab — the CTA when the user has no key. */
  onOpenEncryptionSettings: () => void
  /** Opens the in-app buy-address flow (the "Get an alias" CTAs). */
  onBuyAddress: () => void
}

export function ComposeModal({
  onClose,
  ctx,
  bridgeError,
  draft,
  selfAddresses,
  ownedAliases,
  minimized,
  setMinimized,
  onOpenEncryptionSettings,
  onBuyAddress,
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
  // The prefilled baseline the body is measured against for dirtiness. The
  // FIRST value is a ref (a late-arriving signature must not shift it), and the
  // signature-fold effect below keeps it in lockstep. `baseline` state mirrors
  // the ref for render-time comparison without accessing the ref in render.
  const initialBodyRef = useRef(body)
  const [baseline, setBaseline] = useState(body)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const toRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const defaultAddress = defaultNpubAddress(account?.npub)

  const fromAddress = useMemo(
    () =>
      deriveFromAddress({
        inboxFilter,
        selfAddresses,
        senderAddress: settings.senderAddress,
        ownedAliases,
        defaultAddress,
      }),
    [inboxFilter, selfAddresses, settings.senderAddress, defaultAddress, ownedAliases],
  )
  const fromOptions = useMemo(
    () => deriveFromOptions(selfAddresses, fromAddress),
    [selfAddresses, fromAddress],
  )

  const recipients = useMemo(() => parseRecipients(to), [to])
  const npubBlocked =
    isNpubSender(fromAddress) && hasKnownLegacyRecipient(recipients, ctx.localDomains)
  const hasAlias = ownedAliases.length > 0

  const encryption = useComposerEncryption({
    settings,
    fromAddress,
    recipients,
    discover: true,
  })
  const { canEncrypt, encrypt, mixed, missingKeys, discovering, hasFromKey, setUserOverride } =
    encryption
  const reason = noEncryptReason({
    encrypt,
    mixed,
    missingKeys,
    hasFromKey,
    recipientCount: recipients.length,
    fromAddress,
    onOpenEncryptionSettings,
  })
  // Anchored popover explaining the red lock; toggled by clicking it.
  const [showLockInfo, setShowLockInfo] = useState(false)

  // --- recipient autocomplete over past correspondents ---
  const autocomplete = useRecipientAutocomplete({
    to,
    contacts,
    onPick: setTo,
    toInputRef: toRef,
  })

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
    setBaseline(nextInitial)
  }, [settings.signature, draft?.body, body])

  // Anything the user typed beyond what was prefilled.
  const isDirty =
    to !== (draft?.to ?? '') ||
    subject !== (draft?.subject ?? '') ||
    body !== baseline

  function requestClose() {
    if (isDirty && !sending) setConfirmingDiscard(true)
    else onClose()
  }
  // Latest values for the window-level Escape/mousedown effects, which must not
  // re-bind the listeners on every keystroke. Synced in an effect (writing a ref
  // during render is a React violation).
  const closeStateRef = useRef({ isDirty, sending, requestClose })
  useEffect(() => {
    closeStateRef.current = { isDirty, sending, requestClose }
  })

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Escape backs out of the confirmation first, so it can never be the
      // key that discards a draft.
      if (confirmingDiscard) setConfirmingDiscard(false)
      else if (minimized) setMinimized(false)
      else closeStateRef.current.requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmingDiscard, minimized, setMinimized])

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
  }, [minimized, setMinimized])

  async function handleSend() {
    // A subject is not required — RFC 2822 allows an empty one, and the reader
    // shows "(no subject)". Only a recipient is mandatory.
    if (!account || !active || !to.trim()) return
    const toList = parseRecipients(to)
    setSending(true)
    setError('')
    try {
      // The From alias's own key signs any encrypted body; unlock it if locked.
      // With mixed encryption (below) this applies to BOTH the inline-encrypted
      // compose path and send.ts's per-recipient legacy path — each needs the
      // session passphrase once, after which it's cached for the tab.
      const fromKey = ownKeypairFor(settings, fromAddress)
      let passphrase =
        fromKey?.passphraseProtected ? getSessionPassphrase(fromKey.fingerprint) ?? undefined : undefined
      if (fromKey?.passphraseProtected && !passphrase) {
        const entered = window.prompt('Enter your PGP key passphrase to sign this message')
        if (!entered) {
          setError('A passphrase is required to sign and send an encrypted message.')
          setSending(false)
          return
        }
        setSessionPassphrase(fromKey.fingerprint, entered)
        passphrase = entered
      }

      // Encrypt the body in place when the toggle is on: the inline-PGP block
      // replaces the plaintext, so every wrap (each recipient plus the Sent
      // self-copy) carries the armored body.
      let outgoingBody = body
      if (encrypt) {
        outgoingBody = await encryptBody({
          body,
          fromAddress,
          recipients: toList,
          settings,
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
        // Let the send path encrypt per-recipient for legacy/bridge recipients
        // (mixed encryption): those with keys get PGP ciphertext, the rest
        // plaintext. Nostr-direct recipients are already gift-wrap encrypted.
        pgp: {
          pgpKeys: settings.pgpKeys,
          pgpKeyring: settings.pgpKeyring,
        },
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  // One-click fix for the bridge-sender bounce: the From is derived from the
  // active inbox, so switching to an owned alias is expressed the same way the
  // From <select> does it. Clearing the error lets the banner fall away once
  // the sender is legal again.
  function switchToAlias() {
    if (ownedAliases.length === 0) return
    setInboxFilter(ownedAliases[0], true)
    setError('')
  }

  if (minimized) {
    return <ComposerMinimized subject={subject} onRestore={() => setMinimized(false)} />
  }

  const canSend = Boolean(to.trim()) && !sending && !npubBlocked

  return (
    <div
      // Full-screen sheet on phones; a docked panel from md up. On desktop the
      // wrapper lets clicks through (`md:pointer-events-none`) so the rest of
      // the app stays usable while composing — the outside-click-to-minimize
      // effect above handles tucking the panel away. On phones the backdrop is
      // solid and is the way out of the sheet.
      // Phones: a full-screen sheet (the windowed bottom-sheet felt cramped).
      // md+: a docked panel from the bottom-right that leaves the app usable.
      className="pointer-events-auto fixed inset-0 z-50 flex flex-col bg-foreground/20 md:pointer-events-none md:items-end md:justify-end md:bg-transparent md:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="New message"
        // Full height on phones (safe-area padded top and bottom so the header
        // clears the notch and the footer clears the home bar; the insets are 0
        // on desktop, so these are inert there); a fixed docked card from md up.
        className="pointer-events-auto safe-top safe-bottom flex h-full w-full flex-col overflow-hidden border border-border bg-card shadow-2xl md:h-[32rem] md:max-w-xl md:rounded-xl"
      >
        <ComposerHeader
          isReply={Boolean(draft?.inReplyTo)}
          onMinimize={() => setMinimized(true)}
          onClose={requestClose}
        />

        {confirmingDiscard && (
          <DiscardBanner
            onKeep={() => setConfirmingDiscard(false)}
            onDiscard={onClose}
          />
        )}

        <div className="flex flex-col divide-y divide-border border-b border-border">
          <RecipientField
            to={to}
            toInputRef={toRef}
            onToChange={(value) => {
              setTo(value)
              autocomplete.resetActiveSuggestion()
            }}
            onFocus={autocomplete.onRecipientFocus}
            onBlur={autocomplete.onRecipientBlur}
            onKeyDown={autocomplete.onRecipientKeyDown}
            suggestions={autocomplete.suggestions}
            activeIndex={autocomplete.activeIndex}
            onPickSuggestion={autocomplete.applySuggestion}
          />
          <SubjectField subject={subject} onChange={setSubject} />
        </div>

        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your message"
          className="min-h-[8rem] flex-1 resize-none bg-transparent px-3.5 py-3 text-[13.5px] leading-relaxed text-foreground placeholder:text-subtle focus:outline-none"
        />

        {error && (
          <ErrorBanner
            error={error}
            fix={isUnregisteredSenderError(error) ? <AliasFix alias={ownedAliases[0]} onSwitch={switchToAlias} onBuyAddress={onBuyAddress} /> : undefined}
          />
        )}

        {npubBlocked && <NpubGuardBanner fix={<AliasFix alias={ownedAliases[0]} onSwitch={switchToAlias} onBuyAddress={onBuyAddress} />} />}

        {bridgeError && <BridgeUnavailableBanner message={bridgeError} />}

        {discovering && !encrypt && <DiscoveryBanner />}

        {encrypt && (
          <EncryptedBanner
            mixed={mixed}
            encryptedCount={recipients.length - missingKeys.length}
            missingKeys={missingKeys}
          />
        )}

        <ComposerFooter
          fromAddress={fromAddress}
          fromOptions={fromOptions}
          onFromChange={(address) => {
            // The From is derived from inboxFilter, so a pick is expressed by
            // updating the filter — which mirrors the choice into the sidebar
            // highlight (app-wide) without clearing the open message.
            setInboxFilter(address, true)
          }}
          hasAlias={hasAlias}
          onBuyAddress={onBuyAddress}
          encrypt={encrypt}
          mixed={mixed}
          canEncrypt={canEncrypt}
          missingKeysCount={missingKeys.length}
          recipientsCount={recipients.length}
          onToggleEncrypt={() => {
            if (encrypt) setUserOverride(false)
            else setUserOverride(true)
          }}
          onToggleLockInfo={() => setShowLockInfo((v) => !v)}
          showLockInfo={showLockInfo}
          noEncryptReason={reason}
          onDismissLockInfo={() => setShowLockInfo(false)}
          onRunLockFix={() => {
            setShowLockInfo(false)
            reason?.action?.()
          }}
          sending={sending}
          canSend={canSend}
          onSend={handleSend}
        />
      </div>
    </div>
  )
}