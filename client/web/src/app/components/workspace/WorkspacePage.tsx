import { useCallback, useEffect, useState } from 'react'
import type { ActiveSigner } from '@formstr/signer'
import { useAccountStore } from '@/app/store/account'
import { Button } from '@/app/components/ui/Button'
import { AlertIcon, BackIcon, CheckIcon, PlusIcon } from '@/app/components/ui/icons'
import { Field, inputClass } from '@/app/components/settings/Field'
import InvoiceQR from '@/components/InvoiceQR'
import {
  createSeatInvoice,
  fetchDomainDns,
  fetchMyDomains,
  fetchSeatPacks,
  registerDomain,
  rotateDomainToken,
  verifyDomain,
  type DomainDnsRecords,
  type DomainStatus,
  type SeatInvoice,
  type SeatPack,
  type VerifyOutcome,
  type WorkspaceDomain,
} from '@/app/lib/api/workspace'
import { Nip98AuthError } from '@/app/lib/api/addresses'
import { DnsPanel } from './DnsPanel'
import { MembersPanel } from './members'
import { SetupProgress, VerifyStatus } from './presenters'
import { buildSteps } from './workspaceUi'

/**
 * The Workspace page: run your own mail domain on this bridge.
 *
 * A top-level route (`/mails/workspace`), not a Settings pane — it is a
 * multi-step setup flow (add → DNS → verify → addresses), so it needs the room,
 * and the Settings modal is built for single-pane tweaks. Settings keeps a
 * launcher entry.
 *
 * Layout mirrors the flow: add first, then a progress rail, then the records to
 * publish, then members and seats. Verification state is fetched from the
 * server rather than inferred (only the server resolves DNS), and DNS records
 * are shown exactly as the API returns them so the UI cannot drift from the
 * verifier.
 */
export function WorkspacePage({ onBack }: { onBack: () => void }) {
  const { account, active } = useAccountStore()
  const [domains, setDomains] = useState<WorkspaceDomain[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!active) return
    setLoading(true)
    setError(null)
    try {
      const list = await fetchMyDomains(active)
      setDomains(list)
      setSelected((current) =>
        current && list.some((d) => d.domain === current)
          ? current
          : (list[0]?.domain ?? null),
      )
    } catch (e) {
      setError(
        e instanceof Nip98AuthError
          ? 'Session rejected — sign in again'
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setLoading(false)
    }
  }, [active])

  useEffect(() => {
    // Deferred a microtask — see DomainDetail's loadDns effect for why.
    let alive = true
    queueMicrotask(() => {
      if (alive) void load()
    })
    return () => {
      alive = false
    }
  }, [load])

  const current = domains.find((d) => d.domain === selected) ?? null

  return (
    <div className="mail-app safe-y flex h-[100dvh] flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border px-3 py-3 md:px-6">
        <Button size="sm" variant="ghost" onClick={onBack} className="md:hidden">
          <BackIcon className="h-4 w-4" /> Back
        </Button>
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Settings</div>
          <h1 className="text-base font-semibold tracking-tight">Workspace</h1>
        </div>
        {current && (
          <VerifyStatus
            status={current.status}
            verifiedAt={current.verified_at ?? null}
          />
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-5 md:px-6">
          {!active || !account ? (
            <Field label="Workspace">
              <p className="text-[11.5px] text-subtle">Sign in to manage a mail domain.</p>
            </Field>
          ) : (
            <>
              {/* 1. Add first — it is the entry point to everything below. */}
              <AddDomainForm active={active} onAdded={load} />

              {loading && domains.length === 0 && (
                <p className="text-[11.5px] text-subtle">Loading your domains…</p>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
                  <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
                  <p className="flex-1 text-[11.5px] leading-relaxed text-destructive">{error}</p>
                  <Button size="sm" onClick={() => void load()} className="flex-none">
                    Try again
                  </Button>
                </div>
              )}

              {!loading && !error && domains.length === 0 && (
                <p className="text-[11.5px] leading-relaxed text-subtle">
                  Add a domain above and we&apos;ll show you exactly which DNS records
                  to publish, then verify it for you.
                </p>
              )}

              {domains.length > 0 && (
                <Field label="Your domains">
                  <div className="flex flex-col gap-1">
                    {domains.map((d) => (
                      <button
                        key={d.domain}
                        type="button"
                        onClick={() => setSelected(d.domain)}
                        className={`flex items-center justify-between rounded-md border px-3 py-2 text-left font-mono text-[11px] ${
                          d.domain === selected
                            ? 'border-primary bg-muted'
                            : 'border-input hover:bg-muted/50'
                        }`}
                      >
                        <span className="min-w-0 truncate">{d.domain}</span>
                        <VerifyStatus status={d.status} />
                      </button>
                    ))}
                  </div>
                </Field>
              )}

              {current && (
                <DomainDetail
                  key={current.domain}
                  active={active}
                  domain={current}
                  ownPubkey={account.pubkey}
                  onChanged={load}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Add a domain — the first action on the page. */
function AddDomainForm({
  active,
  onAdded,
}: {
  active: ActiveSigner
  onAdded: () => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const domain = value.trim()
    if (!domain) return
    setBusy(true)
    setError(null)
    try {
      await registerDomain(active, domain)
      setValue('')
      await onAdded()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field
      label="Add a domain"
      hint="You'll need access to its DNS settings. Nothing is routed until it is verified."
    >
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="yourdomain.com"
          aria-label="Domain name"
          className={inputClass}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
        <Button size="sm" variant="primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
          <PlusIcon className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {error && <p className="mt-1.5 text-[11.5px] text-destructive">{error}</p>}
    </Field>
  )
}

/** The selected domain: progress, DNS, members, seats. */
function DomainDetail({
  active,
  domain,
  ownPubkey,
  onChanged,
}: {
  active: ActiveSigner
  domain: WorkspaceDomain
  ownPubkey: string
  onChanged: () => Promise<void>
}) {
  const [dns, setDns] = useState<DomainDnsRecords | null>(null)
  const [status, setStatus] = useState<DomainStatus>(domain.status)
  const [verifiedAt, setVerifiedAt] = useState<string | null>(domain.verified_at ?? null)
  const [seatsUsed, setSeatsUsed] = useState(domain.seats_used ?? 0)
  const handleSeats = useCallback((used: number) => setSeatsUsed(used), [])
  const [busy, setBusy] = useState(false)
  const [loadingDns, setLoadingDns] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // Bumping this forces MembersPanel to refetch — after a seat purchase the
  // member/seat view must update without a full page refresh.
  const [membersRefresh, setMembersRefresh] = useState(0)

  const loadDns = useCallback(async () => {
    setLoadingDns(true)
    try {
      const res = await fetchDomainDns(active, domain.domain)
      setDns(res.dns)
      setStatus(res.status)
      setVerifiedAt(res.verified_at)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingDns(false)
    }
  }, [active, domain.domain])

  useEffect(() => {
    // Deferred a microtask: `loadDns` sets loading state, and a synchronous
    // setState in an effect body causes cascading renders (the codebase's
    // useOwnedAddresses uses the same queueMicrotask pattern).
    let alive = true
    queueMicrotask(() => {
      if (alive) void loadDns()
    })
    return () => {
      alive = false
    }
  }, [loadDns])

  async function runVerify() {
    setBusy(true)
    setMessage(null)
    try {
      const outcome: VerifyOutcome = await verifyDomain(active, domain.domain)
      if (outcome.status === 'verified') {
        // Reload DNS after verification: the DKIM key is generated *at*
        // activation, so the value fetched before it was a placeholder. Without
        // this refetch the signature looked missing even on success.
        await loadDns()
        setMessage(
          outcome.onboarding?.dkim === 'unavailable'
            ? 'Verified — but the DKIM key could not be generated. Mail may fail authentication until it is.'
            : 'Verified — mail will start routing shortly.',
        )
      } else if (outcome.status === 'no-token') {
        setMessage(
          outcome.found.length
            ? `Found a different TXT value: ${outcome.found.join(', ')}`
            : 'No matching TXT record found yet. DNS can take a few minutes.',
        )
      } else if (outcome.status === 'not-found') {
        setMessage('Record not found yet. If you just added it, wait a moment and retry.')
      } else {
        setMessage(outcome.message)
      }
      await onChanged()
    } catch (e) {
      // 503 = resolver trouble, not a wrong setup.
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function rotate() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await rotateDomainToken(active, domain.domain)
      setDns(res.dns)
      setMessage('New token issued — update the TXT record.')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const steps = buildSteps({ active: status === 'active', seatsUsed })

  return (
    <>
      <Field label="Setup steps" hint="Follow these in order — each step depends on the last.">
        <SetupProgress steps={steps} />
      </Field>

      <DnsPanel
        domain={domain.domain}
        dns={dns}
        status={status}
        verifiedAt={verifiedAt}
        busy={busy}
        message={message}
        loading={loadingDns}
        onVerify={() => void runVerify()}
        onRotate={() => void rotate()}
      />

      <MembersPanel
        active={active}
        domain={domain}
        disabled={status !== 'active'}
        ownPubkey={ownPubkey}
        refreshToken={membersRefresh}
        onSeats={handleSeats}
        onChanged={async () => {
          await onChanged()
        }}
      />

      <SeatsPanel
        active={active}
        domain={domain}
        onPurchased={async () => {
          // Refresh the domain list (seats_total changed) *and* the member/seat
          // panel, so the new seats are visible immediately.
          setMembersRefresh((n) => n + 1)
          await onChanged()
        }}
      />
    </>
  )
}

/** Buy seats. Payment handoff reuses the shared invoice UI. */
function SeatsPanel({
  active,
  domain,
  onPurchased,
}: {
  active: ActiveSigner
  domain: WorkspaceDomain
  onPurchased: () => Promise<void>
}) {
  const [packs, setPacks] = useState<SeatPack[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [invoice, setInvoice] = useState<SeatInvoice | null>(null)

  useEffect(() => {
    fetchSeatPacks()
      .then(setPacks)
      .catch(() => {
        // Non-fatal: packs are a convenience; buying still works once they load.
      })
  }, [])

  async function buy(seats: number) {
    setBusy(seats)
    setMessage(null)
    try {
      setInvoice(await createSeatInvoice(active, domain.domain, seats))
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function paid() {
    setInvoice(null)
    setMessage('Paid — seats added.')
    await onPurchased()
  }

  if (invoice) {
    return (
      <Field label="Pay for seats">
        <InvoiceQR
          invoice={invoice.invoice}
          hash={invoice.paymentHash}
          amount={invoice.amount}
          unit="sats"
          onPaid={() => void paid()}
        />
        <button
          type="button"
          onClick={() => setInvoice(null)}
          className="mt-2 text-[11.5px] text-subtle underline"
        >
          Cancel
        </button>
      </Field>
    )
  }

  return (
    <Field
      label="Buy seats"
      hint="One seat per address. Volume discounts apply automatically; one-time payment in sats."
    >
      <div className="flex flex-wrap gap-2">
        {packs.map((pack) => (
          <Button
            key={pack.seats}
            size="sm"
            variant="ghost"
            onClick={() => void buy(pack.seats)}
            disabled={busy != null}
          >
            <CheckIcon className="h-3.5 w-3.5" />
            {pack.seats} seats — {pack.totalSats} sats
            {pack.discountPercent > 0 ? ` (${pack.discountPercent}% off)` : ''}
          </Button>
        ))}
      </div>
      {message && <p className="mt-1.5 text-[11.5px] text-subtle">{message}</p>}
    </Field>
  )
}
