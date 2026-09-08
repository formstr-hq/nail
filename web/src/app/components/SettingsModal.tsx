import { useEffect, useRef, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useSettingsStore } from '@/app/store/settings'
import { useThemeStore } from '@/app/store/theme'
import { useDevStore } from '@/app/store/dev'
import { useOwnedAddresses } from '@/app/hooks/useOwnedAddresses'
import { useBridgeAddress, useSenderDraft } from '@/app/hooks/useSenderDraft'
import { fetchDmRelayList, publishDmRelays } from '@/app/lib/nostr/relays'
import { Button, IconButton } from '@/app/components/ui/Button'
import { XIcon, AlertIcon, BackIcon, ChevronRightIcon } from '@/app/components/ui/icons'
import { SECTIONS, type SectionId } from '@/app/components/settings/sections'

export type { SectionId } from '@/app/components/settings/sections'
import { AddressesSection } from '@/app/components/settings/sections/AddressesSection'
import { RelaysSection } from '@/app/components/settings/sections/RelaysSection'
import { ComposingSection } from '@/app/components/settings/sections/ComposingSection'
import { AppearanceSection } from '@/app/components/settings/sections/AppearanceSection'
import { HelpSection } from '@/app/components/settings/sections/HelpSection'
import { KeyBackupSection } from '@/app/components/settings/sections/KeyBackupSection'
import { PgpSettings } from '@/app/components/PgpSettings'

interface SettingsModalProps {
  onClose: () => void
  /** Which pane to open on. Defaults to Addresses. */
  initialSection?: SectionId
}

export function SettingsModal({ onClose, initialSection }: SettingsModalProps) {
  const { account, active } = useAccountStore()
  const { settings, save } = useSettingsStore()
  const { preference, setPreference } = useThemeStore()
  const { debugPanel, setDebugPanel } = useDevStore()
  const {
    addresses,
    loading: addressesLoading,
    error: addressesErrorRaw,
    reload: reloadAddresses,
  } = useOwnedAddresses()

  const bridgeAddress = useBridgeAddress()
  const senderDraft = useSenderDraft({
    addresses,
    bridgeAddress,
    savedSenderAddress: settings.senderAddress,
  })

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

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

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
        {
          ...settings,
          senderAddress: senderDraft.senderAddress || undefined,
          signature: signature || undefined,
        },
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
        className="safe-bottom flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-2xl md:h-[540px] md:max-w-2xl md:rounded-xl"
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
                <AddressesSection
                  hasAccount={Boolean(account)}
                  addresses={addresses}
                  addressesLoading={addressesLoading}
                  addressesError={addressesErrorRaw ?? ''}
                  reloadAddresses={reloadAddresses}
                  senderOptions={senderDraft.senderOptions}
                  senderMode={senderDraft.senderMode}
                  senderAddress={senderDraft.senderAddress}
                  onSenderModeChange={senderDraft.handleSenderModeChange}
                  onSenderAddressChange={senderDraft.setSenderAddress}
                />
              )}

              {section === 'relays' && <RelaysSection relays={relays} onChange={setRelays} />}

              {section === 'composing' && (
                <ComposingSection signature={signature} onChange={setSignature} />
              )}

              {section === 'encryption' && <PgpSettings />}

              {section === 'security' && <KeyBackupSection />}

              {section === 'appearance' && (
                <AppearanceSection
                  preference={preference}
                  onThemeChange={setPreference}
                  debugPanel={debugPanel}
                  onDebugPanelChange={setDebugPanel}
                />
              )}

              {section === 'help' && <HelpSection />}

              <p className="mt-auto border-t border-border pt-4 text-[11px] leading-relaxed text-subtle">
                Your address, signature and sender settings are encrypted and
                synced to your relays as a kind 30078 event. Theme is kept on
                this device only.
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