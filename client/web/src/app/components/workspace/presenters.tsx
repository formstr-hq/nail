import { Fragment, useState } from 'react'
import type { DomainDnsRecord, DomainStatus } from '@/app/lib/api/workspace'
import { CheckIcon, ChevronRightIcon, CopyIcon, InfoIcon } from '@/app/components/ui/icons'
import { DNS_HELP } from './workspaceUi'
import type { SetupStep } from './workspaceUi'

/**
 * Workspace presenters. Store wiring, protocol calls and signer calls live in
 * the containers (`WorkspacePage` / `DomainDetail`); these render from props
 * only, so they are cheap to test and cannot reach a relay.
 */

/** A labelled chip carrying the domain's verification status. */
export function VerifyStatus({
  status,
  verifiedAt,
}: {
  status: DomainStatus
  verifiedAt?: string | null
}) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
        <CheckIcon className="h-3.5 w-3.5" />
        Verified
        {verifiedAt && (
          <span className="font-normal text-emerald-700/80">
            · {new Date(verifiedAt).toLocaleDateString()}
          </span>
        )}
      </span>
    )
  }
  if (status === 'suspended') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive">
        Suspended
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Pending verification
    </span>
  )
}

/**
 * The setup progress as a breadcrumb trail: completed steps, the step you are
 * on, and what remains, read left-to-right. The current step is emphasised and
 * carries its detail; the trail shows at a glance how far along the setup is.
 */
export function SetupProgress({ steps }: { steps: SetupStep[] }) {
  const currentIndex = Math.max(
    0,
    steps.findIndex((s) => s.state === 'current'),
  )
  const current = steps[currentIndex]

  return (
    <div>
      <ol
        className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
        aria-label="Setup progress"
      >
        {steps.map((step, i) => {
          const done = step.state === 'done'
          const isCurrent = step.state === 'current'
          return (
            <Fragment key={step.id}>
              {i > 0 && (
                <ChevronRightIcon
                  className="h-3.5 w-3.5 flex-none text-subtle/60"
                  aria-hidden="true"
                />
              )}
              <li
                aria-current={isCurrent ? 'step' : undefined}
                className={[
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] leading-none',
                  done
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
                    : isCurrent
                      ? 'border-primary bg-primary/10 font-semibold text-foreground'
                      : 'border-input bg-muted text-subtle',
                ].join(' ')}
              >
                {done ? (
                  <CheckIcon className="h-3 w-3 flex-none" />
                ) : (
                  <span className="flex h-4 w-4 flex-none items-center justify-center rounded-full border border-current text-[9px] font-semibold">
                    {i + 1}
                  </span>
                )}
                <span>{step.title}</span>
              </li>
            </Fragment>
          )
        })}
      </ol>
      {current && current.state !== 'done' && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">{current.title}:</span>{' '}
          {current.detail}
        </p>
      )}
    </div>
  )
}

/** Copy-to-clipboard with a brief "Copied" confirmation. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {
            // Clipboard blocked (insecure context / permission). The value is
            // on screen and selectable; do not pretend it copied.
          })
      }}
      className="flex flex-none items-center gap-1 rounded border border-input px-1.5 py-0.5 text-[10.5px] text-subtle hover:bg-accent hover:text-foreground"
    >
      {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** One labelled field of a record, with its own copy button. */
function RecordField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 border-t border-input/60 py-1.5 first:border-t-0 first:pt-0 last:pb-0">
      <span className="w-12 flex-none pt-0.5 text-[10px] uppercase tracking-wide text-subtle">
        {label}
      </span>
      <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">
        {value}
      </code>
      <CopyButton value={value} label={label.toLowerCase()} />
    </div>
  )
}

/**
 * A DNS record an owner has to create at their registrar.
 *
 * Each value carries its own copy button so a non-technical owner never has to
 * transcribe a long string by hand, and the fields are labelled in the words a
 * DNS form uses (Type / Name / Value) rather than being raw lines.
 */
export function DnsRecordRow({
  kind,
  record,
  showHelp = true,
}: {
  kind: keyof typeof DNS_HELP
  record: DomainDnsRecord
  showHelp?: boolean
}) {
  const help = DNS_HELP[kind]
  const value =
    record.priority != null ? `${record.priority} ${record.value}` : record.value
  return (
    <div className="rounded-md border border-input bg-muted px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-foreground">{help.label}</span>
        {showHelp && (
          <InfoNote label={help.label} title={help.why} where={help.where} />
        )}
      </div>
      <RecordField label="Type" value={record.type} />
      <RecordField label="Name" value={record.name} />
      <RecordField label="Value" value={value} />
    </div>
  )
}

/**
 * The info affordance. A small `i` that reveals the explanation inline rather
 * than as a hover-only tooltip, so it also works on touch (the platform the
 * app most often runs on).
 */
export function InfoNote({
  label,
  title,
  where,
}: {
  label: string
  title: string
  where: string
}) {
  return (
    <details className="group relative flex-none">
      <summary
        aria-label={`About the ${label} record`}
        className="flex h-4 w-4 cursor-pointer list-none items-center justify-center rounded-full text-subtle hover:text-foreground [&::-webkit-details-marker]:hidden"
      >
        <InfoIcon className="h-3.5 w-3.5" />
      </summary>
      <div
        role="note"
        className="absolute right-0 z-10 mt-1 w-60 rounded-md border border-border bg-card p-2.5 text-[11px] leading-relaxed text-muted-foreground shadow-lg"
      >
        {title}
        <div className="mt-1.5 text-[10.5px] text-subtle">
          <span className="font-medium text-muted-foreground">Where: </span>
          {where}
        </div>
      </div>
    </details>
  )
}
