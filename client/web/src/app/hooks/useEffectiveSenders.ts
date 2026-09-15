import { useMemo } from 'react'
import { useMailStore } from '@/app/store/mail'
import { useAccountStore } from '@/app/store/account'
import { useBridgeStore } from '@/app/store/bridge'
import { effectiveSender } from '@/app/lib/mail/senderProof'
import type { MailAddress } from '@/app/types/mail'

/**
 * The effective sender for every stored message, re-derived whenever the
 * message set or any live resolution state changes (bridge probes, NIP-05
 * verdicts, account). Deliberately a derivation, not a cache: a verdict that
 * lands late must repaint the alias index and the contact list, not freeze the
 * fallback those callers saw first.
 *
 * This does NOT start lookups — only useSenderIdentity (rendered rows) does.
 * An address with no verdict yet reads as `checking`, so these callers fall
 * back to the key and self-correct when the verdict arrives.
 */
export function useEffectiveSenders(): Map<string, MailAddress> {
  const emails = useMailStore((s) => s.emails)
  const ownPubkey = useAccountStore((s) => s.account?.pubkey ?? null)
  const bridges = useBridgeStore((s) => s.probes)
  const nip05 = useBridgeStore((s) => s.nip05)

  return useMemo(() => {
    const map = new Map<string, MailAddress>()
    for (const email of Object.values(emails)) {
      map.set(email.id, effectiveSender(email, { ownPubkey, bridges, nip05 }))
    }
    return map
  }, [emails, ownPubkey, bridges, nip05])
}
