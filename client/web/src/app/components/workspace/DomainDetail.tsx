import { useCallback, useEffect, useState } from 'react'
import type { ActiveSigner } from '@formstr/signer'
import { Field } from '@/app/components/settings/Field'
import {
  fetchDomainDns,
  rotateDomainToken,
  verifyDomain,
  type DomainDnsRecords,
  type DomainStatus,
  type VerifyOutcome,
  type WorkspaceDomain,
} from '@/app/lib/api/workspace'
import { DnsPanel } from './DnsPanel'
import { MembersPanel } from './members'
import { SeatsPanel } from './billing'
import { SetupProgress } from './presenters'
import type { Toast } from './Snackbar'
import { buildSteps } from './workspaceUi'

type Tab = 'setup' | 'participants' | 'billing'

const TABS: { id: Tab; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'participants', label: 'Participants' },
  { id: 'billing', label: 'Billing' },
]

/**
 * One domain's workspace, split into tabs so the screen is not DNS + members +
 * billing all at once.
 *
 *  - **Setup** — progress trail, DNS records, verify.
 *  - **Participants** — who holds which addresses, seats.
 *  - **Billing** — seat top-ups.
 *
 * State (DNS, status, seat usage) lives here because the breadcrumb and the
 * Participants summary both read it; the panels below stay presenters.
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
  const [tab, setTab] = useState<Tab>('setup')
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

  const steps = buildSteps({ active: status === 'active', seatsUsed })
  const activeNow = status === 'active'

  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="eyebrow">Domain</div>
          <h2 className="truncate font-mono text-[14px] font-semibold">{domain.domain}</h2>
        </div>
      </div>

      {/* Tab bar. ARIA tablist so keyboard/AT users get the right semantics. */}
      <div role="tablist" aria-label="Workspace sections" className="mt-2 flex gap-1 border-b border-border">
        {TABS.map((t) => {
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
              {t.id === 'participants' && seatsUsed > 0 && (
                <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-subtle">
                  {seatsUsed}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div role="tabpanel" className="flex flex-col gap-5 pt-4">
        {tab === 'setup' && (
          <>
            <Field
              label="Setup progress"
              hint="Where you are in getting mail running on this domain."
            >
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
          </>
        )}

        {tab === 'participants' && (
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
        )}

        {tab === 'billing' && (
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
        )}
      </div>
    </div>
  )
}
