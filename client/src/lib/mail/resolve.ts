import { nip19 } from 'nostr-tools'
import { isNpub, isHexPubkey, splitAddress } from '@protocol'
import { probeNip05 } from '@/lib/nostr/nip05'

export interface ResolveContext {
  /** Domains this deployment serves NIP-05 records for. */
  localDomains: string[]
  /** The signed-in user's own mail domain, used for header addresses. */
  ownDomain: string
  bridgePubkey: string | null
}

export interface ResolveOutcome {
  /** Reachable directly over Nostr — one gift wrap each. */
  nostr: Array<{ pubkey: string; headerAddress: string }>
  /** Legacy addresses — ALL of these ride in ONE wrap to the bridge. */
  legacy: string[]
  errors: string[]
}

/**
 * A bare npub is not a valid RFC 2822 addr-spec: a parser reading
 * `To: npub1…` treats the whole string as a display *name* with an empty
 * address, which renders as a blank recipient. Write `<npub>@<domain>`.
 */
function nostrHeaderAddress(pubkey: string, domain: string): string {
  return `${nip19.npubEncode(pubkey)}@${domain}`
}

/**
 * Classify each recipient as directly reachable over Nostr or as legacy email
 * that must go through the bridge.
 *
 * Note what falls out of the NIP-05 probe: a registered mailstr address
 * resolves to a pubkey and goes direct, so mailstr-to-mailstr mail never
 * touches the bridge at all. The bridge exists only for legacy domains.
 */
export async function resolveRecipients(
  addresses: string[],
  ctx: ResolveContext,
): Promise<ResolveOutcome> {
  const out: ResolveOutcome = { nostr: [], legacy: [], errors: [] }

  await Promise.all(
    addresses.map(async (address) => {
      const trimmed = address.trim()

      if (isNpub(trimmed)) {
        const pubkey = nip19.decode(trimmed).data as string
        out.nostr.push({ pubkey, headerAddress: nostrHeaderAddress(pubkey, ctx.ownDomain) })
        return
      }

      if (isHexPubkey(trimmed)) {
        out.nostr.push({
          pubkey: trimmed,
          headerAddress: nostrHeaderAddress(trimmed, ctx.ownDomain),
        })
        return
      }

      const parts = splitAddress(trimmed)
      if (!parts) {
        out.errors.push(`Cannot resolve recipient: ${trimmed}`)
        return
      }

      // `<npub>@<domain>` is the header form we write for Nostr-native
      // recipients. Resolve it straight back to the pubkey — without this a
      // reply would fall through to the bridge and be relayed as legacy mail.
      const rawLocal = trimmed.slice(0, trimmed.indexOf('@'))
      if (isNpub(rawLocal)) {
        try {
          out.nostr.push({
            pubkey: nip19.decode(rawLocal).data as string,
            headerAddress: trimmed,
          })
          return
        } catch {
          out.errors.push(`Cannot resolve recipient: ${trimmed}`)
          return
        }
      }

      const pubkey = await probeNip05(trimmed)
      if (pubkey) {
        out.nostr.push({ pubkey, headerAddress: trimmed })
        return
      }

      // A local domain with no NIP-05 record is a mailbox that does not exist.
      // Handing it to the bridge would only earn a slow Postfix bounce for
      // something we already know cannot be delivered.
      if (ctx.localDomains.includes(parts.domain)) {
        out.errors.push(`No such mailbox: ${trimmed}`)
        return
      }

      if (!ctx.bridgePubkey) {
        out.errors.push(`No bridge configured — cannot send to ${trimmed}`)
        return
      }

      out.legacy.push(trimmed)
    }),
  )

  return out
}
