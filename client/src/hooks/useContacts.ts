import { useMemo } from 'react'
import { useMailStore } from '@/store/mail'
import { deriveContacts, type Contact } from '@/lib/mail/contacts'

/**
 * The ranked contact list derived from every decoded email in the store. Recomputed
 * only when the email set changes, so the compose picker stays cheap.
 */
export function useContacts(selfAddresses: string[] = []): Contact[] {
  const emails = useMailStore((s) => s.emails)
  const selfKey = selfAddresses.join(',')
  return useMemo(
    () => deriveContacts(Object.values(emails), selfAddresses),
    // selfAddresses is a fresh array each render; key on its contents instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [emails, selfKey],
  )
}
