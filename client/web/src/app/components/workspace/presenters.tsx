import { Fragment } from 'react'
import type { DomainDnsRecord, DomainStatus } from '@/app/lib/api/workspace'
import { CheckIcon, ChevronRightIcon, InfoIcon } from '@/app/components/ui/icons'
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

/**
 * A DNS record, type first.
 *
 * A DNS provider's form asks for Type before Name/Value, so leading with it
 * removes the mental reordering the old panel forced. The `i` explains what the
 * record is and why it is needed without cluttering the row itself.
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
  return (
    <div className="rounded-md border border-input bg-muted px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-foreground">
            {record.type}
          </span>
          <span className="text-[11px] text-subtle">{help.label}</span>
        </div>
        {showHelp && <InfoNote label={help.label} title={help.why} where={help.where} />}
      </div>
      <code className="mt-1 block break-all font-mono text-[11px]">{record.name}</code>
      <code className="mt-0.5 block break-all font-mono text-[11px] text-subtle">
        {record.priority != null ? `${record.priority} ` : ''}
        {record.value}
      </code>
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
