/**
 * Shared login-modal tuning for the @formstr/signer UI, used by BOTH the client
 * (mail app) and the landing (signup wizard). It's framework-agnostic DOM code
 * (no React), so the apps' React 18 vs 19 split doesn't matter, and it's wired
 * in via a `@signer-ui` path alias rather than a cross-app import (which would
 * break the per-app Docker build contexts). See each app's vite.config /
 * tsconfig `paths`, and the `COPY shared/` in the Dockerfiles.
 *
 * Presentation that genuinely differs between the two (client's brand header;
 * landing's relay defaults) stays in each app's own `tuneLoginUi`, which calls
 * the helpers here.
 */
import { Capacitor } from '@capacitor/core'
import type { Signer } from '@formstr/signer'

/** True inside the native Capacitor app (its WebView); false on the web. */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform()
}

export const ICON_SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'

/** Copy + lucide icon shapes for each sign-in method, keyed by tab id. */
export const TAB_COPY: Record<string, { title: string; desc: string; icon: string }> = {
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
 *  removeInapplicableMethod drops whichever doesn't apply. */
export const SECONDARY_TABS = ['android', 'extension', 'ncryptsec', 'bunker', 'nostrconnect']

/**
 * Turn a raw signer/decryption error into something a person can act on. NIP-49
 * (ncryptsec) decrypts with an AEAD, so a wrong passphrase surfaces as the
 * cipher's opaque "invalid tag" — which means exactly one thing here.
 */
export function friendlyUnlockError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/invalid tag|invalid mac|decrypt|padding|poly1305/i.test(msg)) {
    return 'Incorrect passphrase.'
  }
  return msg
}

/** Mobile keyboards autocapitalize/autocorrect by default, which can silently
 *  alter a passphrase and make NIP-49 fail with an opaque "invalid tag". */
export function hardenPasswordInputs(el: HTMLElement): void {
  el.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => {
    input.setAttribute('autocapitalize', 'none')
    input.setAttribute('autocorrect', 'off')
    input.setAttribute('spellcheck', 'false')
  })
}

/** Apply TAB_COPY (icon + title + desc) to every method tab, then reorder the
 *  secondary methods under an "Already have a key?" divider. The create tab
 *  becomes the primary card (styled in each app's CSS). */
export function styleMethodPicker(el: HTMLElement): void {
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
  if (!tabs) return
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

/**
 * Two-step navigation: a picker list of sign-in methods first, then the chosen
 * method's panel with a back link. The tab row doubles as the list (CSS shows
 * one or the other via the --picker modal class); the package's own tab→panel
 * switching keeps running underneath.
 */
export function methodListNav(el: HTMLElement): () => void {
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
    // A freshly-created ncryptsec backup must be acknowledged before any
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

/** Auto-generate the nostrconnect QR when the Remote (QR) tab opens. */
export function autoGenerateQr(el: HTMLElement): () => void {
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
 * Drop the sign-in method that doesn't apply to this platform: NIP-55 signer
 * apps only on native, a NIP-07 browser extension only on the web. MUST run
 * *after* attachLoginListeners — the package wires the extension button
 * unconditionally, so removing it earlier nulls that query and crashes the
 * modal ("Cannot read properties of null (reading 'addEventListener')").
 */
export function removeInapplicableMethod(el: HTMLElement): void {
  const id = isNativeApp() ? 'extension' : 'android'
  el.querySelector(`[data-tab="${id}"]`)?.remove()
  el.querySelector(`[data-panel="${id}"]`)?.remove()
}

/** Just the methods injectAndroidSigners needs off the app's Signer instance. */
type AndroidSigner = Pick<Signer, 'listAndroidSignerApps' | 'loginWithAndroidSigner'>

/**
 * On native, replace the generic "Signer app" tab with a row per *installed*
 * NIP-55 signer (Amber, Primal, …) shown upfront in the picker, each with the
 * app's own logo. Tapping a row signs in through that signer directly. Async
 * (enumeration is a native round-trip); returns a canceller.
 */
export function injectAndroidSigners(
  el: HTMLElement,
  signer: AndroidSigner,
  deps: { onSuccess: () => void; onError: (msg: string) => void },
): () => void {
  let cancelled = false
  const tabs = el.querySelector<HTMLElement>('.nostr-signer__tabs')
  const genericTab = el.querySelector('[data-tab="android"]')
  el.querySelector('[data-panel="android"]')?.remove()
  if (!tabs) return () => {}

  void signer
    .listAndroidSignerApps()
    .then((apps) => {
      if (cancelled) return
      genericTab?.remove()
      let after: Element | null = tabs.querySelector('.nostr-signer__tabs-label')
      for (const app of apps) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'nostr-signer__tab'

        const icon = document.createElement('span')
        icon.className = 'nostr-signer__tab-icon'
        if (app.iconUrl) {
          const img = document.createElement('img')
          img.src = app.iconUrl // a data:image/png;base64 URI from the plugin
          img.alt = ''
          img.className = 'nostr-signer__signer-logo'
          icon.appendChild(img)
        } else {
          icon.innerHTML = ICON_SVG_OPEN + TAB_COPY.android!.icon + '</svg>'
        }

        const title = document.createElement('span')
        title.className = 'nostr-signer__tab-title'
        title.textContent = `Sign in with ${app.name}`
        const desc = document.createElement('span')
        desc.className = 'nostr-signer__tab-desc'
        desc.textContent = 'NIP-55 signer app'
        const text = document.createElement('span')
        text.className = 'nostr-signer__tab-text'
        text.append(title, desc)
        btn.append(icon, text)

        btn.addEventListener('click', async () => {
          deps.onError('')
          btn.disabled = true
          try {
            await signer.loginWithAndroidSigner({ packageName: app.packageName })
            deps.onSuccess()
          } catch (err) {
            btn.disabled = false
            deps.onError(friendlyUnlockError(err))
          }
        })

        if (after && after.parentElement === tabs) after.after(btn)
        else tabs.appendChild(btn)
        after = btn
      }
    })
    .catch(() => {
      if (!cancelled) genericTab?.remove()
    })

  return () => {
    cancelled = true
  }
}
