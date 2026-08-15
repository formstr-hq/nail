import { useEffect, useRef, useState } from 'react'
import { renderLoginHtml, attachLoginListeners } from '@formstr/signer/ui'
import '@formstr/signer/styles.css'
import { nostrSigner } from '@/lib/nostr/signer'
import { getSignerPool } from '@/lib/nostr/signerPool'
import { markFreshSignup } from '@/lib/freshSignup'
import { DEFAULT_RELAYS } from '@/lib/nostr/constants'
import { NostrSignerPlugin } from 'nostr-signer-capacitor-plugin'
import { useAccountStore } from '@/store/account'
import { isNativeApp } from '@/lib/platform'
import { Button } from '@/components/ui/Button'
import { BrandGlyph } from '@/components/ui/icons'

/*
 * The login-UI helpers below (TAB_COPY, tuneLoginUi, methodListNav,
 * autoGenerateQr) are intentionally duplicated in
 * landing/src/components/SignupWizard.tsx. client/ and landing/ are
 * independent builds — no pnpm workspace, React 18 vs 19, and per-app Docker
 * build contexts — so a cross-app import compiles in dev but breaks
 * `docker compose build` (the sibling directory is outside the context).
 * Future direction: move this DOM tuning upstream into @formstr/signer as
 * config/slots so both apps consume it from the package they already share.
 */

/** Copy + lucide icon shapes for the method picker rows, keyed by tab id. */
const TAB_COPY: Record<string, { title: string; desc: string; icon: string }> = {
  create: {
    title: 'Create a new account',
    desc: 'Fresh key, protected by a passphrase',
    icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  },
  android: {
    title: 'Signer app',
    desc: 'Amber or another NIP-55 signer',
    icon: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  },
  extension: {
    title: 'Browser extension',
    desc: 'Alby, nos2x, or any NIP-07 signer',
    icon: '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
  },
  ncryptsec: {
    title: 'Existing key',
    desc: 'Sign in with an ncryptsec backup',
    icon: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  },
  bunker: {
    title: 'Nostr bunker',
    desc: 'Connect with a bunker:// URI',
    icon: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/><path d="m7.9 7.9 2.7 2.7"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/><path d="m13.4 10.6 2.7-2.7"/><circle cx="7.5" cy="16.5" r=".5" fill="currentColor"/><path d="m7.9 16.1 2.7-2.7"/><circle cx="16.5" cy="16.5" r=".5" fill="currentColor"/><path d="m13.4 13.4 2.7 2.7"/><circle cx="12" cy="12" r="2"/>',
  },
  nostrconnect: {
    title: 'Remote signer (QR)',
    desc: 'Scan with your signer app',
    icon: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  },
}

/** Order of the "already have a key?" rows under the create card. `android`
 *  (NIP-55) shows only in the native app and `extension` only on the web —
 *  tuneLoginUi removes whichever doesn't apply, so listing both is safe. */
const SECONDARY_TABS = ['android', 'extension', 'ncryptsec', 'bunker', 'nostrconnect']

const ICON_SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'

/** Inline mailstr glyph — same mark as the landing favicon. Monochrome + one
 *  spark; the parts are coloured from theme tokens in index.css so the mark
 *  tracks light/dark instead of baking colours into the string. */
const MAILSTR_GLYPH =
  '<svg class="nostr-signer__brand-glyph" viewBox="0 0 64 64" aria-hidden="true">' +
  '<rect class="glyph-env" x="4" y="12" width="56" height="40" rx="8"/>' +
  '<path class="glyph-flap" d="M8 18 L32 38 L56 18" fill="none" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<circle class="glyph-disc" cx="50" cy="14" r="10"/>' +
  '<path class="glyph-spark" d="M50 8.5 L50 19.5 M45.2 11.25 L54.8 16.75 M45.2 16.75 L54.8 11.25" stroke-width="2.4" stroke-linecap="round"/>' +
  '</svg>'

/**
 * Trim the stock login markup down to what makes sense on the web:
 * no Android (NIP-55 needs a native plugin), no relay/permission
 * power-user fields — Remote (QR) goes straight to a QR code on
 * the default relays. The tab row is rebuilt into a method picker:
 * a brand header replaces the stock one, the create tab becomes the
 * primary card, and the rest get icon rows under a divider.
 */
function tuneLoginUi(el: HTMLElement) {
  // Mobile keyboards autocapitalize/autocorrect by default, which can silently
  // alter a passphrase — and NIP-49 then fails to decrypt with an opaque
  // "invalid tag". Turn those off on every password field the modal renders.
  el.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => {
    input.setAttribute('autocapitalize', 'none')
    input.setAttribute('autocorrect', 'off')
    input.setAttribute('spellcheck', 'false')
  })
  const relaysInput = el.querySelector<HTMLInputElement>('.nostr-signer__input--relays')
  if (relaysInput) relaysInput.value = DEFAULT_RELAYS.join(', ')

  const modal = el.querySelector<HTMLElement>('.nostr-signer__modal')
  const brand = document.createElement('div')
  brand.className = 'nostr-signer__brand'
  brand.innerHTML =
    MAILSTR_GLYPH +
    '<h2 class="nostr-signer__brand-title">Sign in</h2>' +
    "<p class='nostr-signer__brand-sub'>Choose how you'd like to access your mail</p>"
  modal?.prepend(brand)

  el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((tab) => {
    const copy = TAB_COPY[tab.dataset.tab ?? '']
    if (!copy) return
    const icon = document.createElement('span')
    icon.className = 'nostr-signer__tab-icon'
    icon.innerHTML = ICON_SVG_OPEN + copy.icon + '</svg>'
    const title = document.createElement('span')
    title.className = 'nostr-signer__tab-title'
    title.textContent = copy.title
    const desc = document.createElement('span')
    desc.className = 'nostr-signer__tab-desc'
    desc.textContent = copy.desc
    const text = document.createElement('span')
    text.className = 'nostr-signer__tab-text'
    text.append(title, desc)
    tab.replaceChildren(icon, text)
  })

  const tabs = el.querySelector<HTMLElement>('.nostr-signer__tabs')
  if (tabs) {
    const divider = document.createElement('div')
    divider.className = 'nostr-signer__tabs-label'
    divider.setAttribute('aria-hidden', 'true')
    divider.textContent = 'Already have a key?'
    tabs.append(divider)
    for (const id of SECONDARY_TABS) {
      const btn = tabs.querySelector(`[data-tab="${id}"]`)
      if (btn) tabs.append(btn)
    }
  }
}

/**
 * Two-step navigation: a picker list of sign-in methods first, then the
 * chosen method's panel with a back link. The tab row doubles as the
 * list (index.css shows one or the other via the --picker modal class);
 * the package's own tab→panel switching keeps running underneath.
 */
function methodListNav(el: HTMLElement): () => void {
  const modal = el.querySelector<HTMLElement>('.nostr-signer__modal')
  const body = el.querySelector<HTMLElement>('.nostr-signer__body')
  if (!modal || !body) return () => {}
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'nostr-signer__back'
  back.textContent = '← All sign-in options'
  body.prepend(back)
  modal.classList.add('nostr-signer__modal--picker')
  const showPanel = () => modal.classList.remove('nostr-signer__modal--picker')
  const showPicker = () => {
    // The freshly-created ncryptsec backup must be acknowledged before any
    // navigation — the CSS :has() rule only hides the button, so refuse here.
    const created = el.querySelector<HTMLElement>('[data-panel="created"]')
    if (created && !created.hidden) return
    modal.classList.add('nostr-signer__modal--picker')
  }
  const tabs = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-tab]'))
  tabs.forEach((tab) => tab.addEventListener('click', showPanel))
  back.addEventListener('click', showPicker)
  return () => {
    tabs.forEach((tab) => tab.removeEventListener('click', showPanel))
    back.removeEventListener('click', showPicker)
  }
}

/**
 * Keep the fixed, vertically-centred login overlay pinned to the *visible*
 * viewport. Android's WebView has no `interactive-widget=resizes-content`, so
 * the on-screen keyboard overlays the layout viewport instead of shrinking it:
 * a `position:fixed; inset:0` overlay stays full-screen and its centred modal —
 * with the passphrase field and the Create button at the bottom — sits behind
 * the keyboard. Sizing the overlay to `visualViewport` (and top-aligning +
 * scrolling once the keyboard eats the height) keeps the submit button
 * reachable. A no-op where `visualViewport` is absent or the viewport is not
 * obscured (desktop, keyboard closed), so the web layout is unchanged.
 */
function fitOverlayToViewport(el: HTMLElement): () => void {
  const root = el.querySelector<HTMLElement>('.nostr-signer__root')
  const vv = window.visualViewport
  if (!root || !vv) return () => {}
  const sync = () => {
    // >120px of hidden height means a keyboard (or similar) is up, not just
    // browser-chrome jitter.
    const obscured = window.innerHeight - vv.height > 120
    root.style.position = 'fixed'
    root.style.left = `${vv.offsetLeft}px`
    root.style.top = `${vv.offsetTop}px`
    root.style.right = 'auto'
    root.style.bottom = 'auto'
    root.style.width = `${vv.width}px`
    root.style.height = `${vv.height}px`
    root.style.alignItems = obscured ? 'flex-start' : ''
    root.style.overflowY = obscured ? 'auto' : ''
  }
  sync()
  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)
  return () => {
    vv.removeEventListener('resize', sync)
    vv.removeEventListener('scroll', sync)
  }
}

/**
 * Drop the sign-in method that doesn't apply to this platform: NIP-55 signer
 * apps exist only on Android, a NIP-07 browser extension only on the web.
 *
 * MUST run *after* attachLoginListeners: the package wires the extension button
 * unconditionally (`on(q('[data-action="extension-login"]'), …)`), so removing
 * that element earlier makes the query null and crashes the whole modal with
 * "Cannot read properties of null (reading 'addEventListener')".
 */
function removeInapplicableMethod(el: HTMLElement) {
  const id = isNativeApp() ? 'extension' : 'android'
  el.querySelector(`[data-tab="${id}"]`)?.remove()
  el.querySelector(`[data-panel="${id}"]`)?.remove()
}

/** Auto-generate the nostrconnect QR when the Remote (QR) tab opens. */
function autoGenerateQr(el: HTMLElement): () => void {
  const tab = el.querySelector<HTMLButtonElement>('[data-tab="nostrconnect"]')
  const qr = el.querySelector<HTMLElement>('[data-region="nostrconnect-qr"]')
  const form = el.querySelector<HTMLFormElement>('[data-form="nostrconnect"]')
  const onClick = () => {
    if (qr?.hidden) form?.requestSubmit()
  }
  tab?.addEventListener('click', onClick)
  return () => tab?.removeEventListener('click', onClick)
}

/**
 * Turn a raw signer/decryption error into something a person can act on. NIP-49
 * (ncryptsec) decrypts with an AEAD, so a wrong passphrase surfaces as the
 * cipher's opaque "invalid tag" (or "invalid MAC"/"unable to decrypt") — which
 * means exactly one thing here: the passphrase was wrong.
 */
function friendlyUnlockError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/invalid tag|invalid mac|decrypt|padding|poly1305/i.test(msg)) {
    return 'Incorrect passphrase.'
  }
  return msg
}

/** Passphrase prompt for a persisted ncryptsec account after a reload. */
function UnlockForm({ onUseAnother }: { onUseAnother: () => void }) {
  const { account, unlockNcryptsec } = useAccountStore()
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await unlockNcryptsec(passphrase)
    } catch (err) {
      setError(friendlyUnlockError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleUnlock} className="flex flex-col gap-3">
      <div className="text-center">
        <div className="eyebrow">Locked</div>
        <p
          className="truncate pt-1 font-mono text-[11px] text-subtle"
          title={account?.npub}
        >
          {account?.npub}
        </p>
      </div>
      <input
        type="password"
        autoFocus
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
      />
      <Button type="submit" variant="primary" disabled={!passphrase || busy} className="w-full">
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
      <button
        type="button"
        onClick={onUseAnother}
        className="text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        Use a different account
      </button>
      {error && <p className="text-center text-[12px] text-destructive">{error}</p>}
    </form>
  )
}

/** Locked non-ncryptsec session that couldn't silently resume. */
function ResumeFailed({ onUseAnother }: { onUseAnother: () => void }) {
  return (
    <div className="flex flex-col gap-3 text-center">
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Your signer didn't answer, so this session couldn't be resumed. Signing in again will
        reconnect it.
      </p>
      <Button variant="primary" onClick={onUseAnother} className="w-full">
        Sign in again
      </Button>
    </div>
  )
}

/**
 * Add a dismiss control to the modal. The stock header (and its close button)
 * is hidden by index.css in favour of the injected brand header, so when the
 * login is shown *over* the app — "add another account" — we drop in our own
 * floating close so the user can back out without signing in. Returns a
 * detacher; a no-op when there is no modal to attach to.
 */
function addCancelAffordance(el: HTMLElement, onCancel: () => void): () => void {
  const modal = el.querySelector<HTMLElement>('.nostr-signer__modal')
  if (!modal) return () => {}
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'nostr-signer__cancel-fab'
  btn.setAttribute('aria-label', 'Cancel')
  btn.innerHTML = '&times;'
  btn.addEventListener('click', onCancel)
  modal.appendChild(btn)
  return () => btn.remove()
}

/**
 * @formstr/signer login modal (NIP-07 / NIP-46 / NIP-49 / NIP-55).
 *
 * Used two ways: as the whole login page (no props), and — with `onCancel` —
 * over the app to add a second account, where a successful `onLogin` also
 * fires `onLoggedIn` so the caller can dismiss the overlay.
 */
export function SignerLogin({
  onLoggedIn,
  onCancel,
}: {
  onLoggedIn?: () => void
  onCancel?: () => void
} = {}) {
  const refresh = useAccountStore((s) => s.refresh)
  const [error, setError] = useState('')
  const loginRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = loginRef.current
    if (!el) return
    el.innerHTML = renderLoginHtml()
    tuneLoginUi(el)
    const detachCancel = onCancel ? addCancelAffordance(el, onCancel) : undefined
    const binding = attachLoginListeners(el, nostrSigner, {
      pool: getSignerPool(),
      onLogin: () => {
        refresh()
        onLoggedIn?.()
      },
      onCancel,
      onError: (err) => setError(friendlyUnlockError(err)),
    })
    // After the package has wired its listeners, so removing an element can't
    // null out one of its queries (see removeInapplicableMethod).
    removeInapplicableMethod(el)
    const detachQr = autoGenerateQr(el)
    const detachNav = methodListNav(el)
    const detachFit = fitOverlayToViewport(el)
    // The NIP-55 row launches an Android intent to a signer app; if none is
    // installed that intent has no target and crashes the app. So only surface
    // the row once we've confirmed a signer is present — remove it otherwise.
    let signerCheckCancelled = false
    if (isNativeApp()) {
      NostrSignerPlugin.isExternalSignerInstalled()
        .then(({ installed }) => {
          if (!signerCheckCancelled && !installed) {
            el.querySelector('[data-tab="android"]')?.remove()
            el.querySelector('[data-panel="android"]')?.remove()
          }
        })
        .catch(() => {
          if (!signerCheckCancelled) {
            el.querySelector('[data-tab="android"]')?.remove()
            el.querySelector('[data-panel="android"]')?.remove()
          }
        })
    }
    // A brand-new key created here provably has no kind-10050 relay list, so
    // flag it for the relay onboarding. Capture phase on the container runs
    // before the package's own created-ack handler fires onLogin, so the flag
    // is set by the time onboarding reads it. Only the create path clicks
    // created-ack, so imports/extensions are never marked.
    const markCreated = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest('[data-action="created-ack"]')) {
        const pk = nostrSigner.getActiveAccount()?.pubkey
        if (pk) markFreshSignup(pk)
      }
    }
    el.addEventListener('click', markCreated, true)
    return () => {
      signerCheckCancelled = true
      detachFit()
      detachNav()
      detachQr()
      detachCancel?.()
      binding.detach()
      el.removeEventListener('click', markCreated, true)
      el.innerHTML = ''
    }
  }, [refresh, onLoggedIn, onCancel])

  return (
    <>
      <div ref={loginRef} />
      {error && <p className="text-sm text-destructive text-center">{error}</p>}
    </>
  )
}

export function LoginPage() {
  const account = useAccountStore((s) => s.account)
  // Show the full login UI instead of the unlock/resume prompt without
  // logging out first — logout() deletes the stored account (including
  // the ncryptsec), which "use a different account" must never do.
  const [useAnother, setUseAnother] = useState(false)

  const resuming = Boolean(account) && !useAnother

  // The signer package renders its own full-viewport modal, carrying the brand
  // header that tuneLoginUi injects. Wrapping that in a second header would
  // put one behind the overlay where nobody ever sees it, so the page chrome
  // below belongs only to the unlock and resume paths, which are ours.
  if (!resuming) {
    return (
      <div className="bg-graph safe-y min-h-[100dvh] bg-background">
        <SignerLogin />
      </div>
    )
  }

  return (
    <div className="bg-graph safe-y flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col gap-6 py-10">
        <div className="flex flex-col items-center gap-2 text-center">
          <BrandGlyph size={38} />
          <h1 className="text-xl font-semibold tracking-tight">Mail by Form*</h1>
          <p className="text-[12.5px] text-muted-foreground">Email that travels over Nostr</p>
        </div>

        {account!.method === 'ncryptsec' ? (
          <UnlockForm onUseAnother={() => setUseAnother(true)} />
        ) : (
          <ResumeFailed onUseAnother={() => setUseAnother(true)} />
        )}

        <p className="text-center text-[11px] leading-relaxed text-subtle">
          Your private key stays in your signer. This app never sees it.
        </p>
      </div>
    </div>
  )
}
