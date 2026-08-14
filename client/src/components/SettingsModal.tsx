import { useEffect, useRef, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { useThemeStore, type ThemePreference } from '@/store/theme'
import { useOwnedAddresses } from '@/hooks/useOwnedAddresses'
import { fetchDmRelayList, publishDmRelays } from '@/lib/nostr/relays'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'
import { RelayManager } from '@/components/RelayManager'
import { buyAddressUrl } from '@/lib/api/config'
import { Button, IconButton } from '@/components/ui/Button'
import {
  XIcon,
  AlertIcon,
  AtSignIcon,
  InboxIcon,
  PenIcon,
  SunIcon,
  PlusIcon,
  BackIcon,
  ChevronRightIcon,
} from '@/components/ui/icons'

// Sentinel select value for "type your own address" — kept distinct from any
// real address string so it can never collide with an owned/bridge option.
const CUSTOM_SENDER = '__custom__'

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

export type SectionId = 'addresses' | 'relays' | 'composing' | 'appearance'

const SECTIONS: { id: SectionId; label: string; icon: typeof AtSignIcon }[] = [
  { id: 'addresses', label: 'Addresses', icon: AtSignIcon },
  { id: 'relays', label: 'Relays', icon: InboxIcon },
  { id: 'composing', label: 'Composing', icon: PenIcon },
  { id: 'appearance', label: 'Appearance', icon: SunIcon },
]

interface SettingsModalProps {
  onClose: () => void
  /** Which pane to open on. Defaults to Addresses. */
  initialSection?: SectionId
}

/** A labelled block with a one-line explanation. Used for every setting. */
function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="eyebrow">{label}</div>
      {hint && <p className="text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}

const inputClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] text-foreground placeholder:text-subtle focus:outline-none'

export function SettingsModal({ onClose, initialSection }: SettingsModalProps) {
  const { account, active } = useAccountStore()
  const { settings, save } = useSettingsStore()
  const { preference, setPreference } = useThemeStore()
  const {
    addresses,
    loading: addressesLoading,
    error: addressesError,
    reload: reloadAddresses,
  } = useOwnedAddresses()

  // Every account has a working inbound bridge address derived from its
  // npub — always offered as an option regardless of purchased names.
  const bridgeAddress = account ? `${account.npub}@${BRIDGE_DOMAIN}` : ''
  const fixedSenderOptions = bridgeAddress ? [...addresses, bridgeAddress] : addresses

  const initialSenderAddress = settings.senderAddress ?? ''
  const [senderAddress, setSenderAddress] = useState(initialSenderAddress)
  // Tracks which <select> option is active: a fixed option's own value, or
  // CUSTOM_SENDER when the free-text input is in play. Derived from the
  // saved value each render (which in practice doesn't change while this
  // modal is open) — if that value isn't one of the fixed options (own
  // addresses may still be loading), it falls into Custom rather than being
  // reset, per the "never regress a saved address" invariant.
  const [senderMode, setSenderMode] = useState<string>(() =>
    fixedSenderOptions.includes(initialSenderAddress) ? initialSenderAddress : CUSTOM_SENDER,
  )

  // `addresses` loads asynchronously — on first open, the mount-time
  // initializer above almost always sees `addresses === []` and falls back
  // to Custom even when the saved address is one of the user's own. Once the
  // fetch resolves, re-classify — but only if the user hasn't touched the
  // picker since mount (still on Custom with the original saved value),
  // so an in-progress edit is never clobbered.
  useEffect(() => {
    if (
      senderMode === CUSTOM_SENDER &&
      senderAddress === initialSenderAddress &&
      fixedSenderOptions.includes(senderAddress)
    ) {
      setSenderMode(senderAddress)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, bridgeAddress])

  const [signature, setSignature] = useState(settings.signature ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [section, setSection] = useState<SectionId>(initialSection ?? 'addresses')
  // Mobile navigates iOS-style: a menu list of sections that you tap into,
  // rather than a horizontal tab strip. `mobileDetail` is whether we're drilled
  // into a section (true) or showing the menu (false). A caller that opens
  // Settings on a specific pane (e.g. Relays) drills straight in. On md+ this
  // flag is inert — the rail and content always show side by side.
  const [mobileDetail, setMobileDetail] = useState(initialSection != null)

  // Inbox (kind-10050) relays. `null` while loading; the ref holds the fetched
  // baseline so Save only republishes when the list actually changed — signing
  // a fresh event on every Save would be wasteful.
  const [relays, setRelays] = useState<string[] | null>(null)
  const initialRelaysRef = useRef<string[] | null>(null)
  useEffect(() => {
    if (!account) return
    let alive = true
    fetchDmRelayList(account.pubkey)
      .then((res) => {
        if (!alive) return
        setRelays(res.relays)
        initialRelaysRef.current = res.relays
      })
      .catch(() => {
        if (alive) setRelays([])
      })
    return () => {
      alive = false
    }
  }, [account])

  const placeholder = `you@${BRIDGE_DOMAIN}`

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function handleSenderModeChange(value: string) {
    setSenderMode(value)
    if (value !== CUSTOM_SENDER) setSenderAddress(value)
  }

  async function handleSave() {
    if (!account || !active) {
      setError('Your session is locked — sign in again to save settings')
      return
    }
    setSaving(true)
    setError('')
    try {
      // Publish the inbox relay list first (its own kind-10050 event) when it
      // changed, then the encrypted settings. Order matters only in that a
      // relay-publish failure should surface before we close.
      const relaysChanged =
        relays !== null &&
        initialRelaysRef.current !== null &&
        (relays.length !== initialRelaysRef.current.length ||
          relays.some((r, i) => r !== initialRelaysRef.current![i]))
      if (relaysChanged) {
        await publishDmRelays(relays!, account.pubkey, active)
        initialRelaysRef.current = relays
      }
      await save(
        { ...settings, senderAddress: senderAddress || undefined, signature: signature || undefined },
        account.pubkey,
        active,
      )
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-0 md:items-center md:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-2xl md:h-[540px] md:max-w-2xl md:rounded-xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="eyebrow flex-1">Settings</span>
          <IconButton title="Close settings" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Left rail — desktop only. On mobile the sections are an iOS-style
              menu list rendered inside the content column below. */}
          <nav
            aria-label="Settings sections"
            className="hidden flex-none p-2 md:flex md:w-44 md:flex-col md:gap-0.5 md:border-r md:border-border"
          >
            {SECTIONS.map((s) => {
              const Icon = s.icon
              const activeSection = section === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  aria-current={activeSection ? 'page' : undefined}
                  className={[
                    'flex flex-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-[120ms]',
                    activeSection
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  ].join(' ')}
                >
                  <Icon className="h-4 w-4 flex-none" />
                  <span>{s.label}</span>
                </button>
              )
            })}
          </nav>

          {/* Mobile menu — tap a row to drill into that section (iOS Settings
              style). Hidden once drilled in, and always hidden from md up. */}
          {!mobileDetail && (
            <nav
              aria-label="Settings sections"
              className="flex flex-col overflow-y-auto py-1 md:hidden"
            >
              {SECTIONS.map((s) => {
                const Icon = s.icon
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setSection(s.id)
                      setMobileDetail(true)
                    }}
                    className="flex items-center gap-3 border-b border-border px-4 py-3 text-left text-[14px] text-foreground last:border-b-0 active:bg-accent"
                  >
                    <Icon className="h-[18px] w-[18px] flex-none text-muted-foreground" />
                    <span className="flex-1">{s.label}</span>
                    <ChevronRightIcon className="h-4 w-4 flex-none text-subtle" />
                  </button>
                )
              })}
            </nav>
          )}

          {/* Content column — always visible on md+; on mobile only once a
              section has been tapped. */}
          <div
            className={[
              mobileDetail ? 'flex' : 'hidden',
              'min-w-0 flex-1 flex-col md:flex',
            ].join(' ')}
          >
            {/* Back to the menu — mobile only. */}
            <button
              type="button"
              onClick={() => setMobileDetail(false)}
              className="flex flex-none items-center gap-1 border-b border-border px-2 py-2 text-[13px] font-medium text-muted-foreground md:hidden"
            >
              <BackIcon className="h-4 w-4" />
              <span>{SECTIONS.find((s) => s.id === section)?.label ?? 'Settings'}</span>
            </button>

            <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 md:px-5">
            {section === 'addresses' && (
              <>
                {account && (
                  <Field
                    label="Your addresses"
                    hint={`Addresses linked to your account on ${BRIDGE_DOMAIN}.`}
                  >
                {addressesLoading && (
                  <p className="text-[11.5px] text-subtle">Loading your addresses…</p>
                )}
                {!addressesLoading && addressesError && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
                    <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
                    <p className="flex-1 text-[11.5px] leading-relaxed text-destructive">
                      {addressesError}
                    </p>
                    <Button size="sm" onClick={reloadAddresses} className="flex-none">
                      Try again
                    </Button>
                  </div>
                )}
                {!addressesLoading && !addressesError && addresses.length === 0 && (
                  <p className="text-[11.5px] text-subtle">
                    No addresses yet. Your npub address always works — buy a name below.
                  </p>
                )}
                {!addressesLoading && !addressesError && addresses.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {addresses.map((addr) => (
                      <code
                        key={addr}
                        className="block w-full min-w-0 truncate rounded-md border border-input bg-muted px-3 py-2 font-mono text-[11px]"
                      >
                        {addr}
                      </code>
                    ))}
                  </div>
                )}
                {/* Purchasing lives in the landing app (the tier/invoice/payment
                    flow only exists there); we deep-link with ?buy=1, which
                    opens its wizard in purchase mode and suppresses its own
                    returning-owner redirect so it can't bounce back here. */}
                <a
                  href={buyAddressUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex h-8 items-center justify-center gap-2 self-start whitespace-nowrap rounded-md border border-primary bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors duration-[120ms] hover:bg-primary/90"
                >
                  <PlusIcon className="h-4 w-4" />
                  Buy a new address
                </a>
                <p className="text-[11px] leading-relaxed text-subtle">
                  Opens the signup page in a new tab. New addresses appear here once paid — reload
                  the list with “Try again”.
                </p>
              </Field>
            )}

                <Field label="Sender address" hint="Shown as the From address on mail you send.">
                  <select
                    value={senderMode}
                    onChange={(e) => handleSenderModeChange(e.target.value)}
                    className={inputClass}
                  >
                    {fixedSenderOptions.map((addr) => (
                      <option key={addr} value={addr}>
                        {addr}
                      </option>
                    ))}
                    <option value={CUSTOM_SENDER}>Custom…</option>
                  </select>
                  {senderMode === CUSTOM_SENDER && (
                    <input
                      value={senderAddress}
                      onChange={(e) => setSenderAddress(e.target.value)}
                      placeholder={placeholder}
                      className={inputClass}
                    />
                  )}
                </Field>
              </>
            )}

            {section === 'relays' && (
              <Field
                label="Inbox relays"
                hint="Where your encrypted mail is delivered and read from (kind 10050)."
              >
                {relays === null ? (
                  <p className="text-[11.5px] text-subtle">Loading your relays…</p>
                ) : (
                  <RelayManager relays={relays} onChange={setRelays} />
                )}
              </Field>
            )}

            {section === 'composing' && (
              <Field
                label="Signature"
                hint="Added to the bottom of new messages, where you can still edit it before sending."
              >
                <textarea
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  placeholder="Sent with Mail by Form*"
                  rows={3}
                  className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
                />
              </Field>
            )}

            {section === 'appearance' && (
              <Field label="Theme">
                <div
                  role="radiogroup"
                  aria-label="Theme"
                  className="flex gap-1 rounded-md border border-input bg-background p-1"
                >
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={preference === t.id}
                      onClick={() => setPreference(t.id)}
                      className={[
                        'flex-1 rounded-sm px-2 py-1.5 text-[12px] font-medium transition-colors duration-[120ms]',
                        preference === t.id
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      ].join(' ')}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </Field>
            )}

            <p className="mt-auto border-t border-border pt-4 text-[11px] leading-relaxed text-subtle">
              Your address, signature and sender settings are encrypted and synced to your relays
              as a kind 30078 event. Theme is kept on this device only.
            </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-t border-border bg-destructive/10 px-4 py-2">
            <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
            <p className="text-[11.5px] leading-relaxed text-destructive">{error}</p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
