import { Button } from '@/app/components/ui/Button'
import type { WorkspaceMember, WorkspaceMemberAddress } from '@/app/lib/api/workspace'
import { shortPubkey } from './workspaceUi'

/** One member, with every address they hold as a removable chip. */
export function MemberRow({
  member,
  domain,
  busy,
  onRevokeAddress,
  onRemove,
}: {
  member: WorkspaceMember
  domain: string
  busy: boolean
  onRevokeAddress: (address: WorkspaceMemberAddress) => void
  onRemove: () => void
}) {
  // Fall back to the legacy single-address shape for responses without the
  // address set (older backend), so the row never renders empty.
  const addresses: WorkspaceMemberAddress[] =
    member.addresses && member.addresses.length > 0
      ? member.addresses
      : member.nip05_id != null
        ? [
            {
              id: 0,
              member_id: member.id,
              nip05_id: member.nip05_id,
              status: 'active',
              address: member.address ?? null,
              local_part: member.local_part ?? null,
            },
          ]
        : []

  return (
    <div className="rounded-md border border-input px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11px]">
            {addresses.length === 0 && <span className="text-subtle">no address yet</span>}
            {addresses.length > 0 && `${addresses.length} address${addresses.length === 1 ? '' : 'es'}`}
          </div>
          <div className="truncate font-mono text-[10px] text-subtle" title={member.pubkey}>
            {shortPubkey(member.pubkey)}
          </div>
        </div>
        <span className="flex-none text-[10px] uppercase text-subtle">{member.role}</span>
        {member.role !== 'owner' && (
          <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy}>
            Remove
          </Button>
        )}
      </div>

      {addresses.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {addresses.map((a) => (
            <span
              key={`${a.id}-${a.nip05_id}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-input bg-muted py-0.5 pl-2.5 pr-1 font-mono text-[11px]"
            >
              {a.address ?? `${a.local_part ?? '?'}@${domain}`}
              {member.role !== 'owner' && (
                <button
                  type="button"
                  aria-label={`Revoke ${a.address ?? a.local_part}`}
                  title="Revoke this address"
                  onClick={() => onRevokeAddress(a)}
                  disabled={busy}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-subtle hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
