import { useCallback, useEffect, useState } from 'react'
import { nip19 } from 'nostr-tools'
import type { ActiveSigner } from '@formstr/signer'
import { Button } from '@/app/components/ui/Button'
import { AlertIcon, CheckIcon, PlusIcon } from '@/app/components/ui/icons'
import { Field, inputClass } from '@/app/components/settings/Field'
import {
  assignMember,
  createSeatInvoice,
  fetchDomainDns,
  fetchMembers,
  fetchMyDomains,
  fetchSeatPacks,
  registerDomain,
  revokeMember,
  rotateDomainToken,
  verifyDomain,
  type DomainDnsRecords,
  type SeatInvoice,
  type SeatPack,
  type SeatView,
  type VerifyOutcome,
  type WorkspaceDomain,
  type WorkspaceMember,
} from '@/app/lib/api/workspace'
import { Nip98AuthError } from '@/app/lib/api/addresses'
import InvoiceQR from '@/components/InvoiceQR'

/**
 * The Workspace pane: run your own mail domain on this bridge.
 *
 * The flow is register → publish DNS → verify → assign addresses, and the UI
 * mirrors that order because each step depends on the last: a domain is not
 * routable until verified, and an address cannot be assigned until the domain
 * is active.
 *
 * Two deliberate choices:
 *  - The verification state is fetched from the server rather than inferred,
 *    because only the server resolves DNS. A "verified" badge that could be
 *    stale would be worse than no badge.
 *  - DNS records are shown exactly as the API returns them, so the UI cannot
 *    drift from what the verifier checks.
 */
export interface WorkspaceSectionProps {
  active: ActiveSigner | null
}

export function WorkspaceSection({ active }: WorkspaceSectionProps) {
  const [domains, setDomains] = useState<WorkspaceDomain[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!active) return
    setLoading(true)
    setError(null)
    try {
      const list = await fetchMyDomains(active)
      setDomains(list)
      setSelected((current) => current ?? list[0]?.domain ?? null)
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
    void load()
  }, [load])

  if (!active) {
    return (
      <Field label="Workspace">
        <p className="text-[11.5px] text-subtle">
          Sign in to manage a mail domain.
        </p>
      </Field>
    )
  }

  const current = domains.find((d) => d.domain === selected) ?? null

  return (
    <>
      <Field
        label="Your domains"
        hint="Email on your own domain, with addresses for your team."
      >
        {loading && <p className="text-[11.5px] text-subtle">Loading…</p>}

        {!loading && error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
            <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
            <p className="flex-1 text-[11.5px] leading-relaxed text-destructive">{error}</p>
            <Button size="sm" onClick={() => void load()} className="flex-none">
              Try again
            </Button>
          </div>
        )}

        {!loading && !error && domains.length === 0 && (
          <p className="text-[11.5px] text-subtle">
            No domains yet. Add one below and we&apos;ll show you the DNS records
            to publish.
          </p>
        )}

        {domains.length > 0 && (
          <div className="flex flex-col gap-1">
            {domains.map((d) => (
              <button
                key={d.domain}
                onClick={() => setSelected(d.domain)}
                className={`flex items-center justify-between rounded-md border px-3 py-2 text-left font-mono text-[11px] ${
                  d.domain === selected
                    ? 'border-primary bg-muted'
                    : 'border-input hover:bg-muted/50'
                }`}
              >
                <span className="min-w-0 truncate">{d.domain}</span>
                <StatusPill status={d.status} />
              </button>
            ))}
          </div>
        )}
      </Field>

      <AddDomainForm active={active} onAdded={load} />
      {current && <DomainDetail active={active} domain={current} onChanged={load} />}
    </>
  )
}

/** Decode an npub to hex, or accept an already-hex key. Null if neither. */
function decodePubkey(input: string): string | null {
  const value = input.trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  if (value.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(value)
      if (decoded.type === 'npub') return decoded.data as string
    } catch {
      return null
    }
  }
  return null
}

function StatusPill({ status }: { status: WorkspaceDomain['status'] }) {
  const style =
    status === 'active'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
      : status === 'suspended'
        ? 'border-destructive/30 bg-destructive/10 text-destructive'
        : 'border-input bg-muted text-subtle'
  return (
    <span className={`ml-2 flex-none rounded px-1.5 py-0.5 text-[10px] uppercase ${style}`}>
      {status}
    </span>
  )
}

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
          className={inputClass}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
        <Button size="sm" onClick={() => void submit()} disabled={busy || !value.trim()}>
          <PlusIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && (
        <p className="mt-1.5 text-[11.5px] text-destructive">{error}</p>
      )}
    </Field>
  )
}

function DomainDetail({
  active,
  domain,
  onChanged,
}: {
  active: ActiveSigner
  domain: WorkspaceDomain
  onChanged: () => Promise<void>
}) {
  const [dns, setDns] = useState<DomainDnsRecords | null>(null)
  const [status, setStatus] = useState(domain.status)
  const [verifiedAt, setVerifiedAt] = useState<string | null>(domain.verified_at ?? null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const loadDns = useCallback(async () => {
    try {
      const res = await fetchDomainDns(active, domain.domain)
      setDns(res.dns)
      setStatus(res.status)
      setVerifiedAt(res.verified_at)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }, [active, domain.domain])

  useEffect(() => {
    void loadDns()
  }, [loadDns])

  async function runVerify() {
    setBusy(true)
    setMessage(null)
    try {
      const outcome: VerifyOutcome = await verifyDomain(active, domain.domain)
      if (outcome.status === 'verified') {
        setStatus('active')
        setMessage('Verified — mail will start routing shortly.')
      } else if (outcome.status === 'no-token') {
        // Show what DNS actually has: a typo'd token is the common failure and
        // "not verified" alone would not reveal it.
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

  return (
    <>
      <Field
        label={`DNS for ${domain.domain}`}
        hint={
          status === 'active'
            ? 'Verified. These records keep mail flowing.'
            : 'Publish these, then verify.'
        }
      >
        {dns ? (
          <div className="flex flex-col gap-1.5">
            {Object.entries(dns).map(([key, record]) => (
              <DnsRow key={key} label={key} record={record} />
            ))}
          </div>
        ) : (
          <p className="text-[11.5px] text-subtle">Loading records…</p>
        )}

        <div className="mt-2 flex flex-wrap gap-2">
          {status !== 'active' && (
            <Button size="sm" onClick={() => void runVerify()} disabled={busy}>
              <CheckIcon className="h-3.5 w-3.5" /> Verify
            </Button>
          )}
          <Button size="sm" onClick={() => void rotate()} disabled={busy}>
            New token
          </Button>
          {verifiedAt && (
            <span className="self-center text-[11px] text-subtle">
              verified {new Date(verifiedAt).toLocaleDateString()}
            </span>
          )}
        </div>

        {message && (
          <p className="mt-2 text-[11.5px] text-subtle" role="status">
            {message}
          </p>
        )}
      </Field>

      <MembersPanel active={active} domain={domain} disabled={status !== 'active'} />
      <SeatsPanel active={active} domain={domain} onPurchased={onChanged} />
    </>
  )
}

function DnsRow({
  label,
  record,
}: {
  label: string
  record: { name: string; type: string; value: string; priority?: number }
}) {
  return (
    <div className="rounded-md border border-input bg-muted px-3 py-2">
      <div className="flex items-center justify-between text-[10px] uppercase text-subtle">
        <span>{label}</span>
        <span>{record.type}</span>
      </div>
      <code className="mt-0.5 block break-all font-mono text-[11px]">
        {record.name}
      </code>
      <code className="mt-0.5 block break-all font-mono text-[11px] text-subtle">
        {record.priority != null ? `${record.priority} ` : ''}
        {record.value}
      </code>
    </div>
  )
}

function MembersPanel({
  active,
  domain,
  disabled,
}: {
  active: ActiveSigner
  domain: WorkspaceDomain
  disabled: boolean
}) {
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [seats, setSeats] = useState<SeatView | null>(null)
  const [pubkey, setPubkey] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetchMembers(active, domain.domain)
      setMembers(res.members)
      setSeats(res.seats)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }, [active, domain.domain])

  useEffect(() => {
    void load()
  }, [load])

  async function assign() {
    setBusy(true)
    setMessage(null)
    try {
      // Accept an npub or hex: an admin copying an identity out of a nostr
      // client will almost always have the npub, and the backend takes hex.
      const decoded = decodePubkey(pubkey.trim())
      if (!decoded) {
        setMessage('That does not look like an npub or a hex pubkey.')
        return
      }
      const res = await assignMember(active, domain.domain, {
        pubkey: decoded,
        name: name.trim(),
      })
      setSeats(res.seats)
      setPubkey('')
      setName('')
      await load()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(memberPubkey: string) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await revokeMember(active, domain.domain, memberPubkey)
      setSeats(res.seats)
      await load()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field
      label="Members"
      hint={
        disabled
          ? 'Verify the domain before assigning addresses.'
          : seats
            ? `${seats.available} of ${seats.total} seats available.`
            : undefined
      }
    >
      {members.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {members.map((m) => (
            <div
              key={m.pubkey}
              className="flex items-center gap-2 rounded-md border border-input px-3 py-2"
            >
              {/* The address is what an admin thinks in; the pubkey is the
                  identity behind it, shown small for reference. */}
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px]">
                  {m.address ?? <span className="text-subtle">no address yet</span>}
                </div>
                <div className="truncate font-mono text-[10px] text-subtle">
                  {m.pubkey.slice(0, 20)}…
                </div>
              </div>
              <span className="flex-none text-[10px] uppercase text-subtle">{m.role}</span>
              {m.role !== 'owner' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void revoke(m.pubkey)}
                  disabled={busy}
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          className={inputClass}
          disabled={disabled || busy}
        />
        <input
          value={pubkey}
          onChange={(e) => setPubkey(e.target.value)}
          placeholder="npub or hex pubkey"
          className={inputClass}
          disabled={disabled || busy}
        />
        <Button
          size="sm"
          onClick={() => void assign()}
          disabled={disabled || busy || !name.trim() || !pubkey.trim()}
        >
          Assign
        </Button>
      </div>
      {message && <p className="mt-1.5 text-[11.5px] text-subtle">{message}</p>}
    </Field>
  )
}

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
      const inv = await createSeatInvoice(active, domain.domain, seats)
      // Hand off to the same invoice UI the mail purchase uses: QR, wallet
      // deep-link, countdown and the payment socket all come from there.
      setInvoice(inv)
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
      hint="Volume discounts apply automatically. One-time payment in sats."
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
            {pack.seats} seats — {pack.totalSats} sats
            {pack.discountPercent > 0 ? ` (${pack.discountPercent}% off)` : ''}
          </Button>
        ))}
      </div>
      {message && <p className="mt-1.5 text-[11.5px] text-subtle">{message}</p>}
    </Field>
  )
}
