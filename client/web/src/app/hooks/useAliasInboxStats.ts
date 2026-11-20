import { useMemo } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useMailStore } from '@/app/store/mail'
import { useSettingsStore } from '@/app/store/settings'
import { foldersOf, resolveFolder } from '@/app/lib/mail/folders'
import type { AliasInboxStats } from '@/app/lib/mail/inboxAddresses'

/**
 * Per-alias Inbox unread counts and last-activity timestamps, for the sidebar
 * and its address picker.
 *
 * One pass over the loaded mail, not one pass per alias: a heavy account may
 * own hundreds of addresses and hold thousands of messages, and the sidebar
 * must not turn that into an O(addresses × mail) scan on every render.
 *
 * "Unread" follows the same rule as the Inbox badge: only the Inbox folder
 * (natural mailbox or explicit inbox override), not Sent/Spam/Archive, and not
 * the user's own self-copies. "Last activity" includes sent copies, because an
 * address you have just written from is still an address you were using.
 */
export function useAliasInboxStats(
  aliases: readonly string[],
  effectiveFrom: ReadonlyMap<string, { address: string }>,
): Map<string, AliasInboxStats> {
  const emails = useMailStore((s) => s.emails)
  const mailState = useMailStore((s) => s.mailState)
  const myPubkey = useAccountStore((s) => s.account?.pubkey)
  // Only the folder definitions matter here. Selecting the whole settings blob
  // would rebuild every alias's stats whenever an unrelated field (such as a
  // pinned-address edit) changes.
  const folderSettings = useSettingsStore((s) => s.settings.folders)

  return useMemo(() => {
    const stats = new Map<string, AliasInboxStats>()
    if (!aliases.length) return stats

    const aliasesByKey = new Set(aliases.map((address) => address.toLowerCase()))
    const folders = foldersOf({ folders: folderSettings })

    for (const email of Object.values(emails)) {
      const flags = mailState[email.id]
      // Collect the aliases this message touched. A Set dedupes an address
      // that appears in both To and Cc.
      const touched = new Set<string>()
      for (const address of email.to) touched.add(address.address.toLowerCase())
      for (const address of email.cc ?? []) touched.add(address.address.toLowerCase())
      const sender = effectiveFrom.get(email.id)?.address
      if (sender) touched.add(sender.toLowerCase())

      const resolved = resolveFolder(email, flags, folders)
      const unreadInbox =
        !(flags?.read ?? email.read) &&
        email.senderPubkey !== myPubkey &&
        (resolved === undefined || resolved === 'inbox')

      for (const address of touched) {
        if (!aliasesByKey.has(address)) continue
        const current = stats.get(address) ?? { unread: 0, lastAt: 0 }
        current.lastAt = Math.max(current.lastAt, email.timestamp)
        if (unreadInbox) current.unread += 1
        stats.set(address, current)
      }
    }

    return stats
  }, [aliases, emails, mailState, myPubkey, folderSettings, effectiveFrom])
}
