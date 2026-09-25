import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { config } from "@/lib/config";
import { useAccountStore } from "@/app/store/account";
import { useComposeOverlay } from "@/app/store/composeOverlay";
import { useBuyOverlay } from "@/app/store/buyOverlay";
import { syncMailNotifications } from "@/app/lib/notifications";
import { installAndroidBackHandler } from "@/app/lib/androidBack";
import { useSettingsStore } from "@/app/store/settings";
import { useMailStore } from "@/app/store/mail";
import { useInbox } from "@/app/hooks/useInbox"
import { useMailMeta } from '@/app/hooks/useMailMeta'
import { useSelfAddresses } from '@/app/hooks/useSelfAddresses'
import { ensureMailIndexKey } from '@/app/hooks/useMailActions'
import { isFreshSignup } from '@/app/lib/freshSignup'
import { useResolveContext } from '@/app/hooks/useResolveContext'
import { useOwnedAddresses } from '@/app/hooks/useOwnedAddresses'
import type { Draft } from '@/app/lib/mail/draft'
import { LoginPage } from '@/app/components/LoginPage'
import { SignerLogin } from '@/app/components/login/SignerLogin'
import { Sidebar } from '@/app/components/Sidebar'
import { EmailList } from '@/app/components/EmailList'
import { EmailView } from '@/app/components/EmailView'
import { ComposeModal } from '@/app/components/ComposeModal'
import { SettingsModal, type SectionId } from '@/app/components/SettingsModal'
import { BuyAddressModal } from '@/app/components/BuyAddressModal'
import { reloadOwnedAddresses } from '@/app/hooks/useOwnedAddresses'

import { OnboardingModal } from '@/app/components/OnboardingModal'
import { BrandGlyph, PenIcon, InboxIcon, AlertIcon } from '@/app/components/ui/icons'
import { IconButton } from '@/app/components/ui/Button'

/** Settings modal route param: a section id, or "menu" for the mobile menu. */
type SettingsParam = SectionId | "menu";

/**
 * The app's own prefix, matching the route it mounts at in src/App.tsx. The
 * Android bundle serves the whole app under its Vite base (CLIENT_BASE_PATH),
 * the web deploy at config.mailsUrl — the same derivation as App.tsx.
 */
const MAIL_APP_PREFIX =
  import.meta.env.BASE_URL.replace(/\/+$/, "") ||
  config.mailsUrl.replace(/\/+$/, "") ||
  "/mails";

function isSettingsParam(v: string | undefined): v is SettingsParam {
  return (
    v === "menu" ||
    v === "addresses" ||
    v === "relays" ||
    v === "composing" ||
    v === "encryption" ||
    v === "security" ||
    v === "appearance" ||
    v === "help"
  );
}

function MailApp() {
  const navigate = useNavigate();
  const location = useLocation();

  // Transient mobile nav drawer — not navigation, so it stays out of the URL
  // (a deep link must never open with a drawer showing). The Android back
  // handler pops it by reading this via the callback below.
  const [navOpen, setNavOpen] = useState(false)

  const { account, active } = useAccountStore()
  const { load, settings, loaded: settingsLoaded, eventExists: settingsEventExists } =
    useSettingsStore()
  const { selectedId, setSelected, syncError, setSyncError } = useMailStore()
  const { addresses } = useOwnedAddresses()
  const { ctx, bridgeError, resolving: bridgeResolving, retry: retryBridge } =
    useResolveContext(addresses)
  const { status, retry } = useInbox()
  // Keep read/archived/trashed state synced across devices via kind-34578 events.
  const { refresh: refreshMeta } = useMailMeta()
  // Every address this account owns — the default npub mailbox, a configured
  // sender address, and any NIP-05 aliases — deduped, case-insensitively,
  // keeping first-seen order (npub mailbox first). Doubles as "everything that
  // is me" for Reply-all and as the per-alias inbox list in the sidebar.
  const selfAddresses = useSelfAddresses()

  const composeDraft = useComposeOverlay((s) => s.draft)
  const composeMinimized = useComposeOverlay((s) => s.minimized)
  const startBlankCompose = useComposeOverlay((s) => s.startBlank)
  const openCompose = useCallback(
    (draft: Draft) => useComposeOverlay.getState().open(draft),
    [],
  )
  const closeCompose = useCallback(
    () => useComposeOverlay.getState().close(),
    [],
  )

  const setComposeMinimized = useCallback(
    (m: boolean) => useComposeOverlay.getState().setMinimized(m),
    [],
  )

  // Overlay state that behaves like navigation lives in the URL: the settings
  // modal (so a pane is deep-linkable and Android back pops it natively) and
  // the add-account signer login.
  const settingsMatch = /^\/settings(?:\/([^/]+))?$/.exec(
    location.pathname.slice(MAIL_APP_PREFIX.length),
  )
  const settingsSection: SettingsParam | null = settingsMatch
    ? isSettingsParam(settingsMatch[1])
      ? (settingsMatch[1] as SettingsParam)
      : "menu"
    : null
  const addingAccount = location.pathname === `${MAIL_APP_PREFIX}/add-account`
  // In-app navigations must stay under the app prefix — a bare "/settings"
  // would escape the /mails route and land on the landing catch-all.
  const openSettings = useCallback(
    (section: SettingsParam) =>
      navigate(
        section === "menu"
          ? `${MAIL_APP_PREFIX}/settings`
          : `${MAIL_APP_PREFIX}/settings/${section}`,
      ),
    [navigate],
  )
  const closeSettings = useCallback(() => navigate(-1), [navigate])
  const setAddingAccount = useCallback(
    (open: boolean) =>
      navigate(open ? `${MAIL_APP_PREFIX}/add-account` : MAIL_APP_PREFIX, {
        replace: true,
      }),
    [navigate],
  )
  // The buy flow is an overlay (store/buyOverlay), not a route: it opens over
  // the Settings pane or an open composer, and a URL would unmount — and lose
  // — that context. The Android back handler pops it first (see handleBack).
  const buyingAddress = useBuyOverlay((s) => s.visible)
  const openBuy = useCallback(() => useBuyOverlay.getState().open(), [])
  const closeBuy = useCallback(() => useBuyOverlay.getState().close(), [])

  // The app's manual "reload": re-open both standing subscriptions, which each
  // kick off a fresh upstream sync. There's no browser refresh in the native
  // app, so this is how a user pulls new mail on demand.
  const refreshMail = useCallback(() => {
    retry()
    retryBridge()
    refreshMeta()
  }, [retry, retryBridge, refreshMeta])

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
  // so the default behaviour bounces the user out of the app. Settings and
  // add-account are real routes now, so history pops handle them natively;
  // the handler only covers the overlays that aren't navigation: the compose
  // window (overlay store) and the open email (store-selected, not a route).
  const handleBack = useCallback((): boolean => {
    // 0. The buy-address wizard is open → close it (it renders above
    //    everything else it can be opened over).
    if (useBuyOverlay.getState().visible) {
      useBuyOverlay.getState().close()
      return true
    }
    // 1. Compose modal is open → close it (or restore it if minimized).
    const compose = useComposeOverlay.getState()
    if (compose.draft) {
      if (compose.minimized) {
        compose.setMinimized(false)
      } else {
        compose.close()
      }
      return true
    }
    // 2. Mobile nav drawer is open → close it.
    if (navOpen) {
      setNavOpen(false)
      return true
    }
    // 3. Reading an email → return to the inbox.
    if (useMailStore.getState().selectedId) {
      setSelected(null)
      return true
    }
    // 4. Root of the client: return false so the back handler exits the app.
    //    (The WebView's first history entry is the landing page, so popping
    //    history would bounce the user out to the marketing site.)
    return false
  }, [setSelected, navOpen])

  useEffect(() => {
    const dispose = installAndroidBackHandler(handleBack)
    return () => {
      void dispose.then((d) => d())
    }
  }, [handleBack])

  // "Write" restores an already-open composer (possibly minimized) rather than
  // discarding its draft for a blank one; only start fresh when none is open.
  const startCompose = useCallback(() => {
    startBlankCompose()
    setNavOpen(false)
  }, [startBlankCompose])

  return (
    <div className="mail-app safe-y flex h-[100dvh] flex-col bg-background text-foreground">
      {syncError && (
        <div className="flex items-center gap-2 border-b border-border bg-destructive/10 px-3 py-1.5">
          <AlertIcon className="h-3.5 w-3.5 flex-none text-destructive" />
          <p className="flex-1 text-[11.5px] leading-relaxed text-foreground">{syncError}</p>
          <button
            type="button"
            onClick={() => setSyncError(null)}
            className="flex-none text-[11.5px] font-semibold text-primary"
          >
            Dismiss
          </button>
        </div>
      )}
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
            onSettings={() => openSettings("menu")}
            onOpenRelays={() => openSettings("relays")}
            onAddAccount={() => setAddingAccount(true)}
            onBuyAddress={() => openBuy()}
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
                  openSettings("menu")
                  setNavOpen(false)
                }}
                onOpenRelays={() => {
                  openSettings("relays")
                  setNavOpen(false)
                }}
                onAddAccount={() => {
                  setAddingAccount(true)
                  setNavOpen(false)
                }}
                onBuyAddress={() => {
                  openBuy()
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

      {composeDraft && (
        <ComposeModal
          onClose={closeCompose}
          ctx={ctx}
          bridgeError={bridgeError}
          bridgeResolving={bridgeResolving}
          draft={composeDraft}
          selfAddresses={selfAddresses}
          ownedAliases={addresses}
          minimized={composeMinimized}
          setMinimized={setComposeMinimized}
          onOpenEncryptionSettings={() => openSettings("encryption")}
          onBuyAddress={() => openBuy()}
        />
      )}
      {settingsSection && (
        <SettingsModal
          initialSection={settingsSection === "menu" ? undefined : settingsSection}
          onClose={closeSettings}
          onBuyAddress={() => openBuy()}
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

      {/* Buying an address embeds the landing's purchase wizard over the app.
          Completion refreshes every owned-address consumer at once (sidebar,
          Settings, composer) via the shared reload tick. */}
      {buyingAddress && (
        <BuyAddressModal
          onClose={() => closeBuy()}
          onComplete={() => {
            reloadOwnedAddresses()
            closeBuy()
          }}
        />
      )}

      {/* Adding an account switches the active one on success, so wipe the
          previous inbox and close the overlay. The signer modal renders its
          own full-screen layer (scoped to the token-driven .mail-signer
          variant); no wrapper needed. */}
      {addingAccount && (
        <div className="mail-signer">
          <SignerLogin
            onLoggedIn={() => {
              useMailStore.getState().clear()
              navigate(MAIL_APP_PREFIX, { replace: true })
            }}
            onCancel={() => navigate(MAIL_APP_PREFIX, { replace: true })}
          />
        </div>
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
      <div className="mail-app safe-y flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-background">
        <BrandGlyph size={30} />
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-subtle">
          Opening your mailbox
        </p>
      </div>
    )
  }

  return account && active ? <MailApp /> : <LoginPage />
}