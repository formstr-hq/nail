import { useMemo } from 'react'
import { useMailStore } from '@/app/store/mail'
import { useEffectiveSenders } from '@/app/hooks/useEffectiveSenders'
import { deriveContacts, type Contact } from '@/app/lib/mail/contacts'

/**
 * The ranked contact list derived from every decoded email in the store. Recomputed
 * only when the email set changes, so the compose picker stays cheap.
 *
 * Senders come from `useEffectiveSenders`, so a spoofed header never becomes a
 * suggestion and a late proof repaints the list.
 */
export function useContacts(selfAddresses: string[] = []): Contact[] {
  const emails = useMailStore((s) => s.emails)
  const effectiveFrom = useEffectiveSenders()
  const selfKey = selfAddresses.join(',')
  return useMemo(
    () => deriveContacts(Object.values(emails), selfAddresses, effectiveFrom),
    // selfAddresses is a fresh array each render; key on its contents instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [emails, selfKey, effectiveFrom],
  )
}
