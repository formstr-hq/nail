import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { fetchDmRelayList, publishDmRelays } from '@/lib/nostr/relays'
import { DEFAULT_RELAYS } from '@/lib/nostr/constants'
import { isFreshSignup, clearFreshSignup } from '@/lib/freshSignup'
import type { InboxStatus } from '@/hooks/useInbox'
import { RelayManager } from '@/components/RelayManager'
import { Button } from '@/components/ui/Button'
import { AlertIcon, BrandGlyph } from '@/components/ui/icons'

// How hard we try to read the current relay list before giving up. A read that
// comes back empty is only trustworthy once relays are actually reachable, so we
// retry a few times to let the connection come up, then show a clear error
// rather than guessing.
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 1500
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// loading   — reading the list / waiting for relays to connect
// has-list  — a kind-10050 was read back; confirm or tweak it (Skip allowed)
// no-list   — confidently no list (fresh key, or relays answered empty);
//             one-click confirm of the recommended set (no Skip)
// unreachable — couldn't reach any relay after MAX_ATTEMPTS and don't know the
//             account is new, so we refuse to guess (publishing could overwrite
//             an unread list) and offer a retry
type Phase = 'loading' | 'has-list' | 'no-list' | 'unreachable'

/**
 * One-time relay setup, shown on the first session an account has no
 * `settings.onboardedAt` (the flag lives in the NIP-44-encrypted settings
 * event, so "seen once" holds across devices).
 *
 * The hard part is telling "this account has no inbox relays" from "we couldn't
 * read them right now" — both come back as an empty kind-10050 lookup, and
 * getting it wrong risks overwriting a real list with defaults. Two signals
 * resolve it: a brand-new key created through our own login UI is known to have
 * no list anywhere (`isFreshSignup`), and otherwise an empty result is only
 * trusted once the inbox has actually reached relays (`status.phase === 'live'`).
 * If neither holds after a few tries, we show a retry instead of publishing.
 */
export function OnboardingModal({ status }: { status: InboxStatus }) {
  const { account, active } = useAccountStore()
  const { settings, save } = useSettingsStore()

  const [relays, setRelays] = useState<string[]>(DEFAULT_RELAYS)
  const [phase, setPhase] = useState<Phase>('loading')
  const [runId, setRunId] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // A key created on the landing (or our own login UI) provably has no list, so
  // we can trust "empty" even before relays connect. Stable per account.
  const knownNew = useMemo(
    () => (account ? isFreshSignup(account.pubkey) : false),
    [account?.pubkey],
  )

  // Did the inbox actually reach relays? That's what makes an empty 10050 mean
  // "no list" rather than "couldn't check". Read through a ref so the retry loop
  // below sees the latest value without restarting on every status tick.
  const reachable = status.phase === 'live' && status.relays.length > 0
  const reachableRef = useRef(reachable)
  useEffect(() => {
    reachableRef.current = reachable
  }, [reachable])

  useEffect(() => {
    if (!account) return
    // A brand-new key provably has no list — no need to read at all, and we must
    // not depend on relays being reachable to move a fresh signup forward.
    if (knownNew) {
      setRelays(DEFAULT_RELAYS)
      setPhase('no-list')
      setError('')
      return
    }
    let alive = true
    ;(async () => {
      setPhase('loading')
      setError('')
      const confident = () => reachableRef.current
      for (let attempt = 0; attempt < MAX_ATTEMPTS && alive; attempt++) {
        let res: { relays: string[]; hasList: boolean }
        try {
          res = await fetchDmRelayList(account.pubkey)
        } catch {
          res = { relays: DEFAULT_RELAYS, hasList: false }
        }
        if (!alive) return
        if (res.hasList) {
          setRelays(res.relays)
          setPhase('has-list')
          return
        }
        setRelays(DEFAULT_RELAYS)
        if (confident()) {
          setPhase('no-list')
          return
        }
        // Not confident yet — give relays a moment to connect, then re-check
        // before spending another attempt.
        await sleep(RETRY_DELAY_MS)
        if (!alive) return
        if (confident()) {
          setPhase('no-list')
          return
        }
      }
      if (alive) setPhase('unreachable')
    })()
    return () => {
      alive = false
    }
    // Keyed on pubkey, not the account object, so a store update that returns a
    // fresh object for the same account can't restart the loop. reachable is
    // read via ref inside the loop, not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.pubkey, runId, knownNew])

  async function finish(publish: boolean) {
    if (!account || !active) {
      setError('Your session is locked — sign in again.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (publish) await publishDmRelays(relays, account.pubkey, active)
      // Stamping onboardedAt flips the gate in App and unmounts this screen.
      await save({ ...settings, onboardedAt: Date.now() }, account.pubkey, active)
      clearFreshSignup()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const canConfirm =
    !busy && relays.length > 0 && (phase === 'has-list' || phase === 'no-list')
  const showEditor = phase === 'has-list' || phase === 'no-list'

  const heading =
    phase === 'unreachable' ? "Couldn't reach your relays" : 'Confirm your inbox relays'

  const description =
    phase === 'has-list'
      ? 'These are the relays your encrypted mail is delivered to and read from. Confirm them, or add and remove relays to change where your mail lives.'
      : phase === 'no-list'
        ? "Here's a recommended set of relays for your encrypted mail — accept it, or add your own. This is where your mail will be delivered."
        : phase === 'unreachable'
          ? "We couldn't reach any relay to check your setup after a few tries. Changing relays now could overwrite an existing list, so let's try again in a moment."
          : 'Checking your current relays…'

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-foreground/40 p-0 backdrop-blur-sm md:items-center md:p-6">
      <div className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-2xl md:max-w-md md:rounded-xl">
        <div className="flex flex-col items-center gap-2 border-b border-border px-5 py-5 text-center">
          <BrandGlyph size={30} />
          <h2 className="text-base font-semibold tracking-tight">{heading}</h2>
          <p className="max-w-xs text-[12px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {phase === 'loading' && (
            <p className="text-[12px] text-subtle">Looking up your relays…</p>
          )}

          {phase === 'unreachable' && (
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-destructive">
                <span className="h-1.5 w-1.5 flex-none rounded-full bg-destructive" />
                Relays unreachable
              </span>
              <Button
                onClick={() => setRunId((n) => n + 1)}
                disabled={busy}
                className="flex-none"
              >
                Retry
              </Button>
            </div>
          )}

          {showEditor && <RelayManager relays={relays} onChange={setRelays} />}

          {showEditor && (
            <p className="text-[11px] leading-relaxed text-subtle">
              Stored as a kind 10050 relay list and synced across your devices. You can change this
              any time from Settings → Relays.
            </p>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 border-t border-border bg-destructive/10 px-5 py-2">
            <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
            <p className="text-[11.5px] leading-relaxed text-destructive">{error}</p>
          </div>
        )}

        {showEditor && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
            {/* Skipping is only offered to someone who already has a relay list —
                they're just re-confirming. A user with none must pick a set:
                skipping would leave them with no published kind-10050 at all,
                undiscoverable to senders and other clients. The empty span keeps
                Confirm right-aligned when there's no skip control. */}
            {phase === 'has-list' ? (
              <button
                type="button"
                onClick={() => finish(false)}
                disabled={busy}
                className="text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                Skip for now
              </button>
            ) : (
              <span />
            )}
            <Button variant="primary" onClick={() => finish(true)} disabled={!canConfirm}>
              {busy ? 'Saving…' : 'Confirm relays'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
