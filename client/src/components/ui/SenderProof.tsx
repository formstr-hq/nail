import type { SenderProof } from '@/types/mail'

/**
 * How each proof is described to the reader.
 *
 * One table so the list row and the reading pane can never disagree about what
 * a proof means. Deliberately no generic "Verified by us": the reader is told
 * *what* was checked, because "the bridge vouched for this address" and "this
 * address's NIP-05 record matches the signing key" are different claims.
 *
 * `trusted` drives the only use of colour here. An unproved sender is the
 * ordinary case on Nostr, not an error, so it gets plain neutral text rather
 * than a warning — reserving the colour for the claim that was actually
 * checked is what keeps it meaningful.
 */
const PROOF: Record<
  SenderProof,
  { trusted: boolean; badge?: string; channel: string; detail: string }
> = {
  'bridge-seal': {
    trusted: true,
    badge: 'Verified',
    channel: 'via email bridge',
    detail: 'Arrived from email. The bridge confirmed this sender owns the address.',
  },
  nip05: {
    trusted: true,
    badge: 'Verified',
    channel: 'over Nostr',
    detail: "Arrived over Nostr. This address's NIP-05 record matches the signing key.",
  },
  'own-seal': {
    trusted: false,
    channel: 'your copy',
    detail: 'Your own copy of this message, signed with your key.',
  },
  none: {
    trusted: false,
    channel: 'unverified sender',
    detail: 'Nothing backs the address on this message, so the signing key is shown instead.',
  },
}

/** One line for a list row: the badge if something was proved, then the route. */
export function SenderProofLine({ proof }: { proof: SenderProof }) {
  const { trusted, badge, channel } = PROOF[proof]
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[9.5px] text-subtle">
      {trusted && badge && (
        <span className="flex-none rounded-sm bg-trust-muted px-1 py-px font-semibold uppercase tracking-[0.06em] text-trust">
          {badge}
        </span>
      )}
      <span className="truncate">{channel}</span>
    </span>
  )
}

/** The full sentence, for the open message. */
export function SenderProofTrace({ proof }: { proof: SenderProof }) {
  const { trusted, badge, detail } = PROOF[proof]
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background/60 px-2.5 py-2">
      {trusted && badge && (
        <span className="mt-px flex-none rounded-sm bg-trust-muted px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-trust">
          {badge}
        </span>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  )
}

/** Whether this proof warrants showing the sender's claimed address as theirs. */
export function isProven(proof: SenderProof): boolean {
  return PROOF[proof].trusted
}
