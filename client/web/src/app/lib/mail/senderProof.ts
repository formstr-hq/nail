import { nip19 } from 'nostr-tools'
import { splitAddress } from '@protocol'
import type { MailAddress, SenderProof } from '@/app/types/mail'
import type { BridgeProbe } from '@/app/lib/nostr/bridge'
import type { Nip05State } from '@/app/lib/nostr/nip05'

export interface SenderProofInputs {
  /** The claimed `From:` as it arrived — never trusted without a check. */
  fromHeader: MailAddress
  /** The kind-13 seal's author: the only identity we can verify. */
  sealPubkey: string
  /** The reader's own pubkey, for the self-sealed outgoing-copy case. */
  ownPubkey: string | null
  /** Live bridge resolution states, as the UI receives them. */
  bridges: BridgeProbe[]
  /** NIP-05 resolution for `fromHeader.address`. */
  nip05: Nip05State
}

/** Proofs that actually back the address on the message. */
export function isProven(proof: SenderProof): boolean {
  return proof === 'bridge-seal' || proof === 'nip05' || proof === 'own-seal'
}

/** Proofs whose answer is "show the sealing key" rather than the header. */
export function showsSigningKey(proof: SenderProof): boolean {
  return !isProven(proof) && proof !== 'checking'
}

/**
 * Derive the sender proof from the current inputs — at RENDER time, never
 * stored on the email.
 *
 * This is the whole point of the exercise: a message decoded before a bridge
 * resolved used to be frozen as unverified forever. Here the same email
 * yields `checking` while a resolution is in flight, `bridge-seal` once the
 * sealing key matches a resolved bridge, and `bridge-unavailable` if every
 * bridge failed — each transition just a re-render with new inputs.
 *
 * Branch order is trust order: our own seal is knowable locally, a resolved
 * bridge is the same proof the bridge performs upstream, an address's NIP-05
 * record is the same proof done client-side. Until those have all failed AND
 * all checks have settled, the honest answer is `checking`, not `none`.
 */
export function deriveSenderProof({
  fromHeader,
  sealPubkey,
  ownPubkey,
  bridges,
  nip05,
}: SenderProofInputs): SenderProof {
  // Our own seal is knowable locally and needs no header, so it is checked
  // before the header-shape guard: an outgoing copy is ours whatever it says.
  if (ownPubkey && sealPubkey === ownPubkey) return 'own-seal'

  const claimed = fromHeader.address.trim()
  // Nothing address-shaped was claimed, so there is no address to back or
  // reject; the signing key is the only identity there is.
  if (!claimed || !claimed.includes('@')) return 'none'

  if (bridges.some((b) => b.status === 'resolved' && b.pubkey === sealPubkey)) {
    return 'bridge-seal'
  }
  if (nip05.status === 'resolved' && nip05.pubkey === sealPubkey) return 'nip05'

  // No proof. Distinguish "still working on it" from "nothing will back this":
  // any unfinished check could still produce a proof, so claiming `none` now
  // would be premature (and, before this change, permanent).
  if (nip05.status === 'resolving') return 'checking'
  if (bridges.length === 0 || bridges.some((b) => b.status === 'resolving')) {
    return 'checking'
  }
  // Every bridge was tried and failed. Unlike `none`, this is our resolver's
  // failure, not evidence about the sender, and the UI says so.
  if (bridges.every((b) => b.status === 'failed')) return 'bridge-unavailable'
  return 'none'
}

/**
 * Which identity a message displays, derived alongside the proof.
 *
 * A backed (or still-being-checked) header is shown; an unbacked one is
 * replaced by the sealing key — as an npub, labelled with the kind-0 name if
 * one exists (self-asserted, so it accompanies the key rather than replacing
 * it).
 */
export function displaySender(
  proof: SenderProof,
  {
    fromHeader,
    sealPubkey,
    profileName,
  }: { fromHeader: MailAddress; sealPubkey: string; profileName?: string | null },
): MailAddress {
  if (!showsSigningKey(proof)) return fromHeader
  return { name: profileName ?? undefined, address: nip19.npubEncode(sealPubkey) }
}

/**
 * The effective sender from already-available state, without triggering any
 * lookup. Used by non-React consumers (the contact list, alias filtering) that
 * must not fan out unbounded NIP-05 probes over every stored message.
 *
 * An unsettled check reads as the KEY, not the header — unlike the rendered UI,
 * which shows the header while marked "checking". These consumers feed
 * side-effecting surfaces (contact suggestions, per-alias filing) where a
 * forged header must never appear even briefly; they self-correct when the
 * verdict lands.
 */
export function effectiveSender(
  email: { fromHeader: MailAddress; senderPubkey: string },
  state: {
    ownPubkey: string | null
    bridges: BridgeProbe[]
    nip05: Record<string, Nip05State>
    profileName?: string | null
  },
): MailAddress {
  const key = email.fromHeader.address.trim().toLowerCase()
  const nip05: Nip05State =
    key.includes('@') && splitAddress(key)
      ? (state.nip05[key] ?? { status: 'resolving' })
      : { status: 'skipped' }
  const proof = deriveSenderProof({
    fromHeader: email.fromHeader,
    sealPubkey: email.senderPubkey,
    ownPubkey: state.ownPubkey,
    bridges: state.bridges,
    nip05,
  })
  // While a check is still running, show the key: the verdict could go either
  // way, and these consumers must not act on a claim nothing backs yet.
  if (proof === 'checking') {
    return { name: state.profileName ?? undefined, address: nip19.npubEncode(email.senderPubkey) }
  }
  return displaySender(proof, {
    fromHeader: email.fromHeader,
    sealPubkey: email.senderPubkey,
    profileName: state.profileName,
  })
}
