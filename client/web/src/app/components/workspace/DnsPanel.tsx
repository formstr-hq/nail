import { useState } from 'react'
import { Button } from '@/app/components/ui/Button'
import { CheckIcon } from '@/app/components/ui/icons'
import { Field } from '@/app/components/settings/Field'
import type { DomainDnsRecords, DomainStatus } from '@/app/lib/api/workspace'
import { DnsRecordRow, VerifyStatus } from './presenters'
import { MAIL_RECORD_KEYS } from './workspaceUi'

/**
 * The DNS panel.
 *
 * Verification is the gate: the TXT proof is shown first and the mail records
 * (MX, SPF, DKIM, DMARC) are presented once the domain is active, because
 * before then they would only add noise. The panel still lets an owner reveal
 * them early — a careful setup may publish everything up front — but the
 * default reflects what actually needs doing now.
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
}) {
  const active = status === 'active'
  const [revealEarly, setRevealEarly] = useState(false)
  const showMail = active || revealEarly

  return (
    <Field
      label={`DNS for ${domain}`}
      hint={
        active
          ? 'Verified. These records keep mail flowing.'
          : 'Publish the verification record, then verify. Mail records unlock after verification.'
      }
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <VerifyStatus status={status} verifiedAt={verifiedAt} />
        <span className="text-[10.5px] text-subtle">Records shown as returned by the verifier</span>
      </div>

      {!dns ? (
        <p className="text-[11.5px] text-subtle">{loading ? 'Loading records…' : 'No records.'}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <DnsRecordRow kind="verify" record={dns.verify} />
          {showMail ? (
            MAIL_RECORD_KEYS.map((key) => (
              <DnsRecordRow key={key} kind={key} record={dns[key]} />
            ))
          ) : (
            <div className="rounded-md border border-dashed border-input px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-subtle">
                {MAIL_RECORD_KEYS.length} mail records (MX, SPF, DKIM, DMARC) appear here once
                the domain is verified. Publish them then — the DKIM key does not exist
                until verification generates it.
              </p>
              <button
                type="button"
                onClick={() => setRevealEarly(true)}
                className="mt-1.5 text-[11px] text-subtle underline hover:text-foreground"
              >
                Show mail records anyway
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!active && (
          <Button size="sm" variant="primary" onClick={onVerify} disabled={busy}>
            <CheckIcon className="h-3.5 w-3.5" /> Verify domain
          </Button>
        )}
        <Button size="sm" onClick={onRotate} disabled={busy}>
          New token
        </Button>
        {active && (
          <Button size="sm" variant="ghost" onClick={onVerify} disabled={busy}>
            Re-run checks
          </Button>
        )}
      </div>

      {message && (
        <p className="mt-2 text-[11.5px] text-subtle" role="status">
          {message}
        </p>
      )}
    </Field>
  )
}
