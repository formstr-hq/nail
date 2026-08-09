import { useState, useEffect, useMemo } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { useMailStore } from '@/store/mail'
import { useInbox } from '@/hooks/useInbox'
import { useResolveContext } from '@/hooks/useResolveContext'
import { useOwnedAddresses } from '@/hooks/useOwnedAddresses'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'
import type { Draft } from '@/lib/mail/draft'
import { LoginPage, SignerLogin } from '@/components/LoginPage'
import { Sidebar } from '@/components/Sidebar'
import { EmailList } from '@/components/EmailList'
import { EmailView } from '@/components/EmailView'
import { ComposeModal } from '@/components/ComposeModal'
import { SettingsModal } from '@/components/SettingsModal'
import { BrandGlyph, PenIcon, InboxIcon } from '@/components/ui/icons'
import { IconButton } from '@/components/ui/Button'

function MailApp() {
  // `null` means no compose window; a Draft (possibly empty) means one is open.
  const [compose, setCompose] = useState<Draft | null>(null)
  const [composeMinimized, setComposeMinimized] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  // The signer login shown over the app to add a second account.
  const [addingAccount, setAddingAccount] = useState(false)

  const { account, active } = useAccountStore()
  const { load, settings } = useSettingsStore()
  const { selectedId, setSelected } = useMailStore()
  const ctx = useResolveContext()
  const { status, retry } = useInbox(ctx.bridgePubkey)
  const { addresses } = useOwnedAddresses()

  useEffect(() => {
    if (!account || !active) return
    load(account.pubkey, active).catch(console.error)
  }, [account, active, load])

  // Every address this account owns: the default npub mailbox, a configured
  // sender address, and any NIP-05 aliases — deduped, case-insensitively,
  // keeping first-seen order (npub mailbox first). Doubles as "everything that
  // is me" for Reply-all and as the per-alias inbox list in the sidebar.
  const selfAddresses = useMemo(() => {
    const candidates = [
      account ? `${account.npub}@${BRIDGE_DOMAIN}` : '',
      settings.senderAddress ?? '',
      ...addresses,
    ].filter(Boolean)
    const seen = new Set<string>()
    return candidates.filter((a) => {
      const key = a.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [account, settings.senderAddress, addresses])

  function openCompose(draft: Draft) {
    setCompose(draft)
    setComposeMinimized(false)
    setNavOpen(false)
  }

  function closeCompose() {
    setCompose(null)
    setComposeMinimized(false)
  }

  // "Write" restores an already-open composer (possibly minimized) rather than
  // discarding its draft for a blank one; only start fresh when none is open.
  const blank: Draft = { to: '', subject: '', body: '' }
  function startCompose() {
    if (compose) setComposeMinimized(false)
    else openCompose(blank)
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      {/* Mobile chrome. The three panes cannot all fit, so navigation moves
          into a drawer and the list/reading panes swap rather than stack. */}
      <header className="flex items-center gap-2 border-b border-border bg-surface-nav px-3 py-2 md:hidden">
        <IconButton title="Open folders" onClick={() => setNavOpen(true)}>
          <InboxIcon className="h-4 w-4" />
        </IconButton>
        <BrandGlyph size={18} />
        <span className="flex-1 text-sm font-semibold tracking-tight">Mail</span>
        <IconButton title="Write a message" onClick={startCompose}>
          <PenIcon className="h-4 w-4" />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="hidden w-56 flex-none md:block">
          <Sidebar
            onCompose={startCompose}
            onSettings={() => setShowSettings(true)}
            onAddAccount={() => setAddingAccount(true)}
            aliases={selfAddresses}
            status={status}
          />
        </div>

        {navOpen && (
          <div className="fixed inset-0 z-40 flex md:hidden">
            <button
              type="button"
              aria-label="Close folders"
              className="absolute inset-0 bg-foreground/30"
              onClick={() => setNavOpen(false)}
            />
            <div className="relative w-60 max-w-[80vw] shadow-2xl">
              <Sidebar
                onCompose={startCompose}
                onSettings={() => {
                  setShowSettings(true)
                  setNavOpen(false)
                }}
                onAddAccount={() => {
                  setAddingAccount(true)
                  setNavOpen(false)
                }}
                aliases={selfAddresses}
                status={status}
              />
            </div>
          </div>
        )}

        {/* Below md only one pane is visible, chosen by whether a message is
            open. From md up both are, so the list keeps a fixed column. */}
        <div
          className={[
            'min-w-0 flex-1 border-border md:max-w-xs md:flex-none md:border-r',
            selectedId ? 'hidden md:block' : 'block',
          ].join(' ')}
        >
          <EmailList status={status} onRetry={retry} />
        </div>

        <div className={['min-w-0 flex-1', selectedId ? 'flex' : 'hidden md:flex'].join(' ')}>
          <EmailView
            onCompose={openCompose}
            selfAddresses={selfAddresses}
            onBack={() => setSelected(null)}
          />
        </div>
      </div>

      {compose && (
        <ComposeModal
          onClose={closeCompose}
          ctx={ctx}
          draft={compose}
          selfAddresses={selfAddresses}
          minimized={composeMinimized}
          setMinimized={setComposeMinimized}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* Adding an account switches the active one on success, so wipe the
          previous inbox and close the overlay. The signer modal renders its
          own full-screen layer; no wrapper needed. */}
      {addingAccount && (
        <SignerLogin
          onLoggedIn={() => {
            useMailStore.getState().clear()
            setAddingAccount(false)
          }}
          onCancel={() => setAddingAccount(false)}
        />
      )}
    </div>
  )
}

export default function App() {
  const { account, active, ready, init } = useAccountStore()

  useEffect(() => {
    void init()
  }, [init])

  if (!ready) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-background">
        <BrandGlyph size={30} />
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-subtle">
          Opening your mailbox
        </p>
      </div>
    )
  }

  return account && active ? <MailApp /> : <LoginPage />
}
