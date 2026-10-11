import { useCallback, useEffect, useState } from 'react'
import type { ActiveSigner } from '@formstr/signer'
import { Button } from '@/app/components/ui/Button'
import { ChevronRightIcon } from '@/app/components/ui/icons'
import {
  fetchDomainDns,
  rotateDomainToken,
  verifyDomain,
  type DomainDnsRecords,
  type DomainStatus,
  type SeatView,
  type VerifyOutcome,
  type WorkspaceDomain,
} from '@/app/lib/api/workspace'
import { DnsPanel } from './DnsPanel'
import { MembersPanel } from './members'
import { SeatsPanel } from './billing'
import { SetupProgress } from './presenters'
import type { Toast } from './Snackbar'
import { buildSteps, nextTab, WORKSPACE_TABS, type WorkspaceTab } from './workspaceUi'
import { checkDnsRecords, type DnsCheckReport } from '@/app/lib/mail/dnsCheck'

/**
 * One domain's workspace, split into tabs so the screen is not DNS + members +
 * billing all at once.
 *
 *  - **Setup** — DNS records and verify.
 *  - **Participants** — who holds which addresses, seats.
 *  - **Billing** — seat top-ups.
 *
 * The setup breadcrumb sits above the tabs, not inside one, so an owner can see
 * the whole path regardless of which tab is open; each crumb jumps to the tab
 * that finishes that step, and the Setup/Participants panels carry an explicit
 * "next" button so the flow never dead-ends on a tab.
 *
 * State (DNS, status, seat usage) lives here because the breadcrumb, the
 * Participants panel and the billing gate all read it; the panels stay
 * presenters.
 */
export function DomainDetail({
  active,
  domain,
  ownPubkey,
  notify,
  onChanged,
}: {
  active: ActiveSigner
  domain: WorkspaceDomain
  ownPubkey: string
  notify: Toast
  onChanged: () => Promise<void>
}) {
  const [tab, setTab] = useState<WorkspaceTab>('setup')
  const [dns, setDns] = useState<DomainDnsRecords | null>(null)
  const [status, setStatus] = useState<DomainStatus>(domain.status)
  const [verifiedAt, setVerifiedAt] = useState<string | null>(domain.verified_at ?? null)
  const [seats, setSeats] = useState<SeatView>({
    total: domain.seats_total ?? 0,
    used: domain.seats_used ?? 0,
    available: Math.max(0, (domain.seats_total ?? 0) - (domain.seats_used ?? 0)),
  })
  const handleSeats = useCallback((next: SeatView) => setSeats(next), [])
  const [busy, setBusy] = useState(false)
  const [loadingDns, setLoadingDns] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // Bumping this forces MembersPanel to refetch — after a seat purchase the
  // member/seat view must update without a full page refresh.
  const [membersRefresh, setMembersRefresh] = useState(0)
  // DNS health-check result (client-side, over DoH). Null until the owner runs
  // a check; used to mark each record and to gate the next step.
  const [dnsReport, setDnsReport] = useState<DnsCheckReport | null>(null)
  const [checkingDns, setCheckingDns] = useState(false)

  const goToTab = useCallback((t: WorkspaceTab) => {
    setTab(t)
    // Keep the workspace body at the top of the scroll container so the change
    // of section is visible, since the tab bar stays where it is.
    document.getElementById('workspace-tabs')?.scrollIntoView({ block: 'start' })
  }, [])

  const goToNext = useCallback(
    (t: WorkspaceTab) => {
      const next = nextTab(t)
      if (next) goToTab(next)
    },
    [goToTab],
  )

  const loadDns = useCallback(async () => {
    setLoadingDns(true)
    try {
      const res = await fetchDomainDns(active, domain.domain)
      setDns(res.dns)
      setStatus(res.status)
      setVerifiedAt(res.verified_at)
      // A fresh record set invalidates any previous check verdict.
      setDnsReport(null)
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
        notify(
          outcome.onboarding?.dkim === 'unavailable'
            ? 'Verified — but the DKIM key could not be generated. Mail may fail authentication until it is.'
            : `${domain.domain} verified — mail will start routing shortly.`,
        )
      } else if (outcome.status === 'no-token') {
        setMessage(
          outcome.found.length
            ? `Found a different TXT value: ${outcome.found.join(', ')} (expected ${outcome.expected})`
            : 'No matching TXT record found yet. DNS can take a few minutes.',
        )
      } else if (outcome.status === 'not-found') {
        setMessage(
          `No TXT record found at _mailstr-verify.${domain.domain} yet. DNS can take a few minutes to propagate — if you just added it, wait and retry.`,
        )
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

  // Client-side DNS health check over DoH. `checkDnsRecords` never throws (a
  // resolver outage becomes per-record `error`), so the owner always gets a
  // verdict rather than a silent failure.
  const runDnsCheck = useCallback(async () => {
    if (!dns) return
    setCheckingDns(true)
    try {
      setDnsReport(await checkDnsRecords(dns))
    } finally {
      setCheckingDns(false)
    }
  }, [dns])

  const steps = buildSteps({ active: status === 'active', seatsUsed: seats.used })
  const activeNow = status === 'active'
  const hasSeats = seats.available > 0
  // The next step is gated on the mail records checking out: handing out
  // addresses before MX/SPF/DKIM/DMARC resolve correctly means mail silently
  // fails. The owner must run and pass the check first.
  const dnsReady = dnsReport?.ok === true

  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="eyebrow">Domain</div>
          <h2 className="truncate font-mono text-[14px] font-semibold">{domain.domain}</h2>
        </div>
      </div>

      {/* The setup trail sits above the tabs: it is the map, the tabs are the
          rooms. Clicking a crumb jumps to the tab that finishes that step. */}
      <div className="mt-3">
        <SetupProgress steps={steps} onGoToStep={goToTab} />
      </div>

      {/* Tab bar. ARIA tablist so keyboard/AT users get the right semantics. */}
      <div
        id="workspace-tabs"
        role="tablist"
        aria-label="Workspace sections"
        className="mt-4 flex gap-1 border-b border-border"
      >
        {WORKSPACE_TABS.map((t) => {
          const selected = tab === t.id
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setTab(t.id)}
              className={[
                '-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors duration-[120ms]',
                selected
                  ? 'border-primary font-semibold text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {t.label}
              {t.id === 'participants' && seats.used > 0 && (
                <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-subtle">
                  {seats.used}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div role="tabpanel" className="flex flex-col gap-5 pt-4">
        {tab === 'setup' && (
          <>
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
              report={dnsReport}
              checking={checkingDns}
              onCheck={() => void runDnsCheck()}
            />

            {/* The forward step is gated on the DNS health check: the owner must
                first confirm MX/SPF/DKIM/DMARC resolve correctly, so nobody
                hands out addresses on a domain whose mail silently fails. */}
            {activeNow ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  className="self-start"
                  onClick={() => goToNext('setup')}
                  disabled={!dnsReady}
                >
                  Continue to participants
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                </Button>
                {!dnsReady && (
                  <p className="text-[11.5px] leading-relaxed text-subtle">
                    Run “Check my DNS” above and fix any issues before continuing.
                  </p>
                )}
              </>
            ) : (
              <p className="text-[11.5px] leading-relaxed text-subtle">
                Once the domain is verified, this tab continues to Participants,
                where you hand out addresses.
              </p>
            )}
          </>
        )}

        {tab === 'participants' && (
          <>
            <MembersPanel
              active={active}
              domain={domain}
              disabled={!activeNow}
              ownPubkey={ownPubkey}
              refreshToken={membersRefresh}
              onSeats={handleSeats}
              onChanged={async () => {
                await onChanged()
              }}
            />

            {/* Out of seats is the common blocker here; route to Billing so the
                fix is one click away, and to Billing again once seats exist. */}
            <Button
              size="sm"
              variant={hasSeats ? 'secondary' : 'primary'}
              className="self-start"
              onClick={() => goToNext('participants')}
            >
              {hasSeats ? 'Continue to billing' : 'Buy seats'}
              <ChevronRightIcon className="h-3.5 w-3.5" />
            </Button>
          </>
        )}

        {tab === 'billing' && (
          <>
            {!hasSeats && (
              <p className="text-[11.5px] leading-relaxed text-subtle">
                You have no seats left. Each address needs one seat — buy seats
                below, then return to Participants to assign addresses.
              </p>
            )}
            <SeatsPanel
              active={active}
              domain={domain}
              onPurchased={async () => {
                // Refresh the domain list (seats_total changed) *and* the
                // member/seat view, so the new seats are visible immediately.
                setMembersRefresh((n) => n + 1)
                notify(`Seats added to ${domain.domain}`)
                await onChanged()
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}
