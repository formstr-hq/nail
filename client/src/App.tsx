import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAccountStore } from '@/store/account'
import { syncMailNotifications } from '@/lib/notifications'
import { installAndroidBackHandler } from '@/lib/androidBack'
import { useSettingsStore } from '@/store/settings'
import { useMailStore } from '@/store/mail'
import { useInbox } from '@/hooks/useInbox'
import { useMailMeta } from '@/hooks/useMailMeta'
import { ensureMailIndexKey } from '@/hooks/useMailActions'
import { isFreshSignup } from '@/lib/freshSignup'
import { useResolveContext } from '@/hooks/useResolveContext'
import { useOwnedAddresses } from '@/hooks/useOwnedAddresses'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'
import type { Draft } from '@/lib/mail/draft'
import { LoginPage, SignerLogin } from '@/components/LoginPage'
import { Sidebar } from '@/components/Sidebar'
import { EmailList } from '@/components/EmailList'
import { EmailView } from '@/components/EmailView'
import { ComposeModal } from '@/components/ComposeModal'
import { SettingsModal, type SectionId } from '@/components/SettingsModal'
import { OnboardingModal } from '@/components/OnboardingModal'
import { BrandGlyph, PenIcon, InboxIcon } from '@/components/ui/icons'
import { IconButton } from '@/components/ui/Button'

function MailApp() {
  // `null` means no compose window; a Draft (possibly empty) means one is open.
  const [compose, setCompose] = useState<Draft | null>(null)
  const [composeMinimized, setComposeMinimized] = useState(false)
  // null = closed. A section id opens Settings drilled straight into that pane
  // (used by the Relays shortcut). 'menu' opens it without a forced section, so
  // on mobile it lands on the iOS-style section menu rather than a detail pane.
  const [settingsSection, setSettingsSection] = useState<SectionId | 'menu' | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  // The signer login shown over the app to add a second account.
  const [addingAccount, setAddingAccount] = useState(false)

  const { account, active } = useAccountStore()
  const { load, settings, loaded: settingsLoaded, eventExists: settingsEventExists } =
    useSettingsStore()
  const { selectedId, setSelected } = useMailStore()
  const ctx = useResolveContext()
  const { status, retry } = useInbox(ctx.bridgePubkey)
  // Keep read/archived/trashed state synced across devices via kind-34578 events.
  const { refresh: refreshMeta } = useMailMeta()
  const { addresses } = useOwnedAddresses()

  // The app's manual "reload": re-open both standing subscriptions, which each
  // kick off a fresh upstream sync. There's no browser refresh in the native
  // app, so this is how a user pulls new mail on demand.
  const refreshMail = useCallback(() => {
    retry()
    refreshMeta()
  }, [retry, refreshMeta])

  useEffect(() => {
    if (!account || !active) return
    // Load settings, then make sure the mail index key exists — minting it now
    // (once) means the first archive/read/trash publishes without stopping to
    // generate and save a key first.
    load(account.pubkey, active)
      .then(() => ensureMailIndexKey(account.pubkey, active))
      .catch(console.error)
  }, [account, active, load])

  // Intercept the Android system back button so it walks the in-app stack
  // (open overlays → reading email → root) instead of popping WebView history
  // — at the root of the client, the first history entry is the landing page,
  // so the default behaviour bounces the user out of the app. The listener
  // reads each overlay's state via the snapshot it closes over, so it sees
  // fresh values on every press without re-binding on every change.
  const handleBack = useCallback((): boolean => {
    // 1. Compose modal is open → close it (or restore it if minimized).
    if (compose) {
      if (composeMinimized) {
        setComposeMinimized(false)
      } else {
        closeCompose()
      }
      return true
    }
    // 2. Settings modal is open → close it.
    if (settingsSection) {
      setSettingsSection(null)
      return true
    }
    // 3. Add-account signer modal is open → cancel it.
    if (addingAccount) {
      setAddingAccount(false)
      return true
    }
    // 4. Mobile nav drawer is open → close it.
    if (navOpen) {
      setNavOpen(false)
      return true
    }
    // 5. Reading an email → return to the inbox.
    if (selectedId) {
      setSelected(null)
      return true
    }
    // 6. Root of the client: do nothing. Returning false leaves the gesture
    //    unhandled. At the root there's no history to pop, so the OS's next
    //    press exits the app — that's the desired behavior, not a bounce to
    //    landing.
    return false
  }, [compose, composeMinimized, settingsSection, addingAccount, navOpen, selectedId])

  useEffect(() => {
    const dispose = installAndroidBackHandler(handleBack)
    return () => {
      void dispose.then((d) => d())
    }
  }, [handleBack])

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
    <div className="safe-y flex h-[100dvh] flex-col bg-background text-foreground">
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
            onSettings={() => setSettingsSection('menu')}
            onOpenRelays={() => setSettingsSection('relays')}
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
            <div className="safe-y relative w-60 max-w-[80vw] bg-surface-nav shadow-2xl">
              <Sidebar
                onCompose={startCompose}
                onSettings={() => {
                  setSettingsSection('menu')
                  setNavOpen(false)
                }}
                onOpenRelays={() => {
                  setSettingsSection('relays')
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
          <EmailList status={status} onRetry={refreshMail} />
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
          ownedAliases={addresses}
          minimized={composeMinimized}
          setMinimized={setComposeMinimized}
        />
      )}
      {settingsSection && (
        <SettingsModal
          initialSection={settingsSection === 'menu' ? undefined : settingsSection}
          onClose={() => setSettingsSection(null)}
        />
      )}

      {/* First-run relay setup — shown once per account (the `onboardedAt` flag
          lives in the synced kind-30078 settings event, so "once" holds across
          devices).

          Only shown when we can actually trust that the user hasn't onboarded:
          either they're a provably-new key (created here, so there's genuinely
          no settings anywhere), or we positively saw their settings event this
          session (`settingsEventExists`) and it carried no `onboardedAt`. A bare
          `!onboardedAt` isn't enough — `settingsLoaded` flips true even when the
          settings event merely timed out, which made this screen re-appear for
          users who had confirmed relays many times before. */}
      {settingsLoaded &&
        !settings.onboardedAt &&
        !addingAccount &&
        account &&
        (isFreshSignup(account.pubkey) || settingsEventExists) && (
          <OnboardingModal status={status} />
        )}

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

  // Drive background mail notifications (Android) off the active account: start
  // on login, restart on account switch, stop on logout. No-op on the web.
  const notifyPubkey = account && active ? account.pubkey : null
  useEffect(() => {
    void syncMailNotifications(notifyPubkey)
  }, [notifyPubkey])

  if (!ready) {
    return (
      <div className="safe-y flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-background">
        <BrandGlyph size={30} />
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-subtle">
          Opening your mailbox
        </p>
      </div>
    )
  }

  return account && active ? <MailApp /> : <LoginPage />
}
