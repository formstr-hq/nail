import { useCallback, useEffect, useState } from 'react'
import { nip19 } from 'nostr-tools'
import type { ActiveSigner } from '@formstr/signer'
import { Button } from '@/app/components/ui/Button'
import { PlusIcon } from '@/app/components/ui/icons'
import { Field, inputClass } from '@/app/components/settings/Field'
import {
  assignMember,
  fetchMembers,
  revokeMember,
  revokeMemberAddress,
  type SeatView,
  type WorkspaceDomain,
  type WorkspaceMember,
  type WorkspaceMemberAddress,
} from '@/app/lib/api/workspace'
import { decodePubkey, shortPubkey } from './workspaceUi'

/**
 * Members and their addresses.
 *
 * An address belongs to an identity (pubkey), and one identity may hold
 * several addresses — the same thing a platform account does with aliases —
 * so this lists addresses under the member rather than assuming one each.
 * Seats are counted per address, so the seat line stays honest as addresses
 * are added and removed.
 */
export function MembersPanel({
  active,
  domain,
  disabled,
  ownPubkey,
  onChanged,
  refreshToken,
  onSeats,
}: {
  active: ActiveSigner
  domain: WorkspaceDomain
  disabled: boolean
  ownPubkey: string | null
  /** Called after any change so the parent can refresh seats/domain state. */
  onChanged: () => Promise<void> | void
  /** Bump to force a refetch (e.g. after a seat purchase). */
  refreshToken?: number
  /** Reports seat usage so the parent's progress rail stays accurate. */
  onSeats?: (used: number) => void
}) {
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [seats, setSeats] = useState<SeatView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetchMembers(active, domain.domain)
      setMembers(res.members)
      setSeats(res.seats)
      onSeats?.(res.seats.used)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }, [active, domain.domain, onSeats])

  useEffect(() => {
    // Deferred a microtask — see WorkspacePage's loadDns effect for why.
    let alive = true
    queueMicrotask(() => {
      if (alive) void load()
    })
    return () => {
      alive = false
    }
  }, [load, refreshToken])

  async function revokeAddress(address: WorkspaceMemberAddress) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await revokeMemberAddress(active, domain.domain, address.nip05_id)
      setSeats(res.seats)
      await load()
      await onChanged()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function removeMember(member: WorkspaceMember) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await revokeMember(active, domain.domain, member.pubkey)
      setSeats(res.seats)
      await load()
      await onChanged()
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
            ? `${seats.available} of ${seats.total} seats available. Each address uses one seat.`
            : undefined
      }
    >
      {members.length > 0 && (
        <div className="mb-2 flex flex-col gap-1.5">
          {members.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              domain={domain.domain}
              busy={busy}
              onRevokeAddress={(a) => void revokeAddress(a)}
              onRemove={() => void removeMember(m)}
            />
          ))}
        </div>
      )}

      <AddMemberForm
        active={active}
        domain={domain.domain}
        disabled={disabled}
        ownPubkey={ownPubkey}
        onAssigned={async () => {
          await load()
          await onChanged()
        }}
      />
      {message && <p className="mt-1.5 text-[11.5px] text-subtle">{message}</p>}
    </Field>
  )
}

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

/**
 * Assign an address to an identity.
 *
 * Accepts an npub or a hex pubkey because an admin copying an identity out of a
 * nostr client will almost always have the npub, while the backend takes hex —
 * both are shown, and "Use my identity" fills in the signed-in account so the
 * common case is one tap plus a name.
 */
export function AddMemberForm({
  active,
  domain,
  disabled,
  ownPubkey,
  onAssigned,
}: {
  active: ActiveSigner
  domain: string
  disabled: boolean
  ownPubkey: string | null
  onAssigned: () => Promise<void> | void
}) {
  const [name, setName] = useState('')
  const [pubkey, setPubkey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ownNpub = ownPubkey ? nip19.npubEncode(ownPubkey) : null

  async function assign() {
    setBusy(true)
    setError(null)
    try {
      const decoded = decodePubkey(pubkey.trim())
      if (!decoded) {
        setError('Enter an npub (starts with npub1…) or a 64-character hex pubkey.')
        return
      }
      const localPart = name.trim().toLowerCase()
      if (!localPart) {
        setError('Enter the address name (the part before @).')
        return
      }
      await assignMember(active, domain, { pubkey: decoded, name: localPart })
      setPubkey('')
      setName('')
      await onAssigned()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="address name"
          aria-label="Address name"
          className={inputClass}
          disabled={disabled || busy}
        />
        <input
          value={pubkey}
          onChange={(e) => setPubkey(e.target.value)}
          placeholder="npub1… or hex pubkey"
          aria-label="Identity pubkey"
          className={inputClass}
          disabled={disabled || busy}
        />
        <Button
          size="sm"
          onClick={() => void assign()}
          disabled={disabled || busy || !name.trim() || !pubkey.trim()}
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Assign
        </Button>
      </div>

      {ownNpub && (
        <button
          type="button"
          onClick={() => setPubkey(ownNpub)}
          disabled={disabled || busy}
          className="self-start text-[11px] text-subtle underline hover:text-foreground disabled:opacity-50"
        >
          Add my identity
        </button>
      )}

      <p className="text-[10.5px] leading-relaxed text-subtle">
        An npub is a Nostr identity in bech32 form; the hex key is the same key
        in raw form. Either works — paste whichever your Nostr client shows.
        You can add several addresses to the same identity.
      </p>

      {error && <p className="text-[11.5px] text-destructive">{error}</p>}
    </div>
  )
}
