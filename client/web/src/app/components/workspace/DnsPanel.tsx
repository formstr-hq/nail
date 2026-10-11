import { useState } from 'react'
import { Button } from '@/app/components/ui/Button'
import { CheckIcon } from '@/app/components/ui/icons'
import { Field } from '@/app/components/settings/Field'
import type { DomainDnsRecords, DomainStatus } from '@/app/lib/api/workspace'
import type { DnsCheckReport, DnsRecordKey } from '@/app/lib/mail/dnsCheck'
import { DnsRecordRow, VerifyStatus } from './presenters'
import { DNS_HELP, MAIL_RECORD_KEYS } from './workspaceUi'

/**
 * The DNS panel, written for someone who has never added a DNS record.
 *
 * The shape follows what the owner actually has to do:
 *
 *  - **Before verification** (pending): a short "what to do" line, then the one
 *    record to add (with copy buttons).
 *  - **After verification** (active): the proof record is gone (its job is
 *    done), and the four records that keep mail flowing are shown.
 *
 * A "Check my DNS" action (driven by the parent) resolves the mail records over
 * DNS-over-HTTPS and marks each one `Correct` / `Missing` / `Incorrect`, so an
 * owner sees *which* record is wrong instead of mail silently failing.
 */
export function DnsPanel({
  domain,
  dns,
  status,
  verifiedAt,
  busy,
  message,
  onVerify,
  onRotate,
  loading,
  report,
  checking,
  onCheck,
}: {
  domain: string
  dns: DomainDnsRecords | null
  status: DomainStatus
  verifiedAt: string | null
  busy: boolean
  message: string | null
  onVerify: () => void
  onRotate: () => void
  loading: boolean
  report?: DnsCheckReport | null
  checking?: boolean
  onCheck?: () => void
}) {
  const active = status === 'active'
  const [revealEarly, setRevealEarly] = useState(false)
  const statusFor = (key: DnsRecordKey) => report?.records.find((r) => r.key === key)?.status
  const issues = report?.records.filter((r) => r.status !== 'ok' && r.status !== 'skip') ?? []

  return (
    <Field label="DNS records" hint={`The DNS settings for ${domain}.`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <VerifyStatus status={status} verifiedAt={verifiedAt} />
        {active && (
          <Button size="sm" variant="ghost" onClick={onVerify} disabled={busy}>
            Re-check
          </Button>
        )}
      </div>

      {!dns ? (
        <p className="text-[11.5px] text-subtle">{loading ? 'Loading records…' : 'No records.'}</p>
      ) : active ? (
        // Verified: the proof record is no longer shown.
        <div className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Your domain is verified. Add the records below at your DNS provider
            (where you bought the domain) so mail can be sent and received.
          </p>
          {MAIL_RECORD_KEYS.map((key) => (
            <DnsRecordRow key={key} kind={key} record={dns[key]} status={statusFor(key)} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            To prove you own this domain, add <strong>one</strong> DNS record at
            your provider (where you bought the domain). Copy the three values
            below into a new record, save it, then press Verify domain. It can
            take a few minutes to go live.
          </p>
          <DnsRecordRow kind="verify" record={dns.verify} />

          {revealEarly ? (
            MAIL_RECORD_KEYS.map((key) => (
              <DnsRecordRow key={key} kind={key} record={dns[key]} status={statusFor(key)} />
            ))
          ) : (
            <div className="rounded-md border border-dashed border-input px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-subtle">
                The {MAIL_RECORD_KEYS.length} records that make mail actually
                work (MX, SPF, DKIM and DMARC) appear here once the domain is
                verified.
              </p>
              <button
                type="button"
                onClick={() => setRevealEarly(true)}
                className="mt-1.5 text-[11px] text-subtle underline hover:text-foreground"
              >
                Show them now
              </button>
            </div>
          )}
        </div>
      )}

      {!active && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" onClick={onVerify} disabled={busy}>
            <CheckIcon className="h-3.5 w-3.5" /> Verify domain
          </Button>
          <button
            type="button"
            onClick={onRotate}
            disabled={busy}
            className="text-[11px] text-subtle underline hover:text-foreground disabled:opacity-50"
          >
            I made a mistake — give me a new code
          </button>
        </div>
      )}

      {dns && onCheck && (
        <div className="mt-4 border-t border-input/60 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11.5px] leading-relaxed text-subtle">
              {report
                ? report.ok
                  ? 'All the mail records below look correct.'
                  : `${issues.length} issue${issues.length === 1 ? '' : 's'} found — see below.`
                : 'Published your records? Check that mail will route correctly.'}
            </p>
            <Button size="sm" variant="secondary" onClick={onCheck} disabled={checking}>
              {checking ? 'Checking…' : 'Check my DNS'}
            </Button>
          </div>
          {issues.length > 0 && (
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
              {issues.map((r) => (
                <li key={r.key}>
                  <span className="font-medium text-foreground">{DNS_HELP[r.key].label}:</span>{' '}
                  {r.detail ?? 'Not set up correctly.'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {message && (
        <p className="mt-2 text-[11.5px] text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </Field>
  )
}
