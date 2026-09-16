import { useEffect, useMemo } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useBridgeStore } from '@/app/store/bridge'
import { useProfile } from '@/app/hooks/useProfile'
import { peekNip05, probeNip05, type Nip05State } from '@/app/lib/nostr/nip05'
import { deriveSenderProof, displaySender, showsSigningKey } from '@/app/lib/mail/senderProof'
import { splitAddress } from '@protocol'
import type { Email, MailAddress, SenderProof } from '@/app/types/mail'

export interface SenderIdentity {
  proof: SenderProof
  /** The identity to render — header when backed, the npub when not. */
  from: MailAddress
}

const NOTHING: SenderIdentity = { proof: 'none', from: { address: '' } }

/**
 * The sender identity for a message, derived from LIVE state on every render.
 *
 * Inputs are the bridge store's probe states (async), the shared NIP-05
 * verdict map, the kind-0 profile, and the message's own raw header/seal. When
 * any of them changes this re-derives — so a message decoded before its bridge
 * resolved visibly flips `checking` → `bridge-seal` with no re-decode, which
 * the old decode-time verdict could not do.
 */
export function useSenderIdentity(email: Email | null | undefined): SenderIdentity {
  const ownPubkey = useAccountStore((s) => s.account?.pubkey ?? null)
  const bridges = useBridgeStore((s) => s.probes)
  const nip05Map = useBridgeStore((s) => s.nip05)

  const claimedAddress = email?.fromHeader.address ?? ''
  // A `<npub>@<domain>` sender is proven from the key itself, and any header
  // that is not an address has no NIP-05 record — neither should probe or wait.
  const lookupable = Boolean(claimedAddress && splitAddress(claimedAddress))

  // Trigger the lookup when no verdict is held yet. The verdict lives in the
  // store, not component state, so every consumer of the same address shares
  // one probe result and a late answer simply re-renders the derivation.
  useEffect(() => {
    if (!lookupable) return
    const key = claimedAddress.toLowerCase()
    // Only a settled verdict is terminal. A `resolving` entry left behind by
    // an unmount must not block a later probe; probeNip05's own in-flight
    // dedup keeps concurrent callers from multiplying the fetch.
    if (useBridgeStore.getState().nip05[key]?.status === 'resolved') return

    // A fresh cache hit answers without a fetch; a miss may take a timeout.
    const cached = peekNip05(claimedAddress)
    if (cached) {
      useBridgeStore.getState().setNip05(claimedAddress, {
        status: 'resolved',
        pubkey: cached.pubkey,
      })
      return
    }

    useBridgeStore.getState().setNip05(claimedAddress, { status: 'resolving' })
    let alive = true
    probeNip05(claimedAddress).then((pubkey) => {
      if (!alive) return
      useBridgeStore.getState().setNip05(claimedAddress, { status: 'resolved', pubkey })
    })
    return () => {
      alive = false
    }
  }, [claimedAddress, lookupable])

  const proof = useMemo(() => {
    if (!email) return 'none' as SenderProof
    const nip05: Nip05State = lookupable
      ? (nip05Map[claimedAddress.toLowerCase()] ?? { status: 'resolving' })
      : { status: 'skipped' }
    return deriveSenderProof({
      fromHeader: email.fromHeader,
      sealPubkey: email.senderPubkey,
      ownPubkey,
      bridges,
      nip05,
    })
  }, [email, claimedAddress, lookupable, ownPubkey, bridges, nip05Map])

  // Kind-0 is only rendered for a sender shown by KEY (a profile name
  // accompanies an unverified npub; a proven header uses its own name). The
  // lookup is therefore gated on that — otherwise every list row would query a
  // profile it will never display. Hook order stays fixed; a null pubkey is a
  // no-op inside the hook.
  const profile = useProfile(
    email && showsSigningKey(proof) ? email.senderPubkey : null,
  )

  return useMemo(() => {
    if (!email) return NOTHING
    return {
      proof,
      from: displaySender(proof, {
        fromHeader: email.fromHeader,
        sealPubkey: email.senderPubkey,
        profileName: profile.name,
      }),
    }
  }, [email, proof, profile.name])
}
