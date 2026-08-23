import { useCallback } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { useMailStore } from '@/store/mail'
import { publishMailMeta, randomMailIndexKey } from '@/lib/nostr/mailMeta'
import { loadSettingsDetailed } from '@/lib/nostr/settings'
import type { MailFlags } from '@/types/mail'

/**
 * The single in-flight index-key bootstrap, shared across every hook instance.
 *
 * The HMAC secret is minted lazily on the first action that needs it. Two
 * actions firing before the first save lands would otherwise each generate a key
 * and race their saves, leaving half our state under an orphaned coordinate.
 * Funnelling every caller through one promise makes the mint happen exactly once.
 */
let indexKeyInflight: Promise<string> | null = null

/**
 * Archive / trash / read actions on a mail.
 *
 * Each is optimistic: the local flag flips immediately (so the list re-files at
 * once) and the kind-34578 metadata event is published in the background. A
 * failed publish is logged, not surfaced — the local change stands and the next
 * successful action (or a reload that re-reads the relay) reconciles it.
 */
export function useMailActions() {
  const setFlag = useMailStore((s) => s.setFlag)

  const apply = useCallback(
    (id: string, patch: Partial<Omit<MailFlags, 'updatedAt'>>) => {
      const { account, active } = useAccountStore.getState()
      if (!account || !active) return

      // No-op if the mail is already in the requested state — avoids a needless
      // relay write on, e.g., re-opening an already-read message.
      const current = useMailStore.getState().mailState[id]
      if (current && (Object.keys(patch) as (keyof typeof patch)[]).every((k) => current[k] === patch[k])) {
        return
      }

      const merged = setFlag(id, patch)

      void (async () => {
        try {
          const indexKey = await ensureMailIndexKey(account.pubkey, active)
          await publishMailMeta(id, merged, account.pubkey, active, indexKey)
        } catch (e) {
          console.error('[mailMeta] failed to publish mail state', e)
        }
      })()
    },
    [setFlag],
  )

  return {
    markRead: useCallback((id: string) => apply(id, { read: true }), [apply]),
    markUnread: useCallback((id: string) => apply(id, { read: false }), [apply]),
    archive: useCallback((id: string) => apply(id, { archived: true, trashed: false }), [apply]),
    unarchive: useCallback((id: string) => apply(id, { archived: false }), [apply]),
    trash: useCallback((id: string) => apply(id, { trashed: true, archived: false }), [apply]),
    // Restore drops both filing flags, so a mail returns to the Inbox whether it
    // was archived or trashed.
    restore: useCallback((id: string) => apply(id, { archived: false, trashed: false }), [apply]),
  }
}

/**
 * Return the account's mail index key, minting and saving one only if the user
 * genuinely doesn't have one yet. Called eagerly at login (so the first
 * archive/read has no extra settings round-trip) and lazily by each action as a
 * fallback. Idempotent and race-safe: concurrent callers share one in-flight
 * mint.
 *
 * Minting writes the settings event, so it must not clobber what's already
 * there. Before generating, it re-fetches the authoritative settings from the
 * relays (not the possibly-stale/empty in-memory copy, which could be empty
 * merely because an earlier fetch timed out) and:
 *
 *  - if a key is already stored, adopts it — never overwrites an existing key
 *    (doing so would orphan every coordinate ever written under it);
 *  - if a settings event exists but couldn't be read, refuses to write — a
 *    blind save would drop whatever that event held, key included;
 *  - otherwise writes the new key merged into the fetched settings, preserving
 *    every other field.
 */
export async function ensureMailIndexKey(
  pubkey: string,
  active: import('@formstr/signer').ActiveSigner,
): Promise<string> {
  const existing = useSettingsStore.getState().settings.mailIndexKey
  if (existing) return existing
  if (indexKeyInflight) return indexKeyInflight

  indexKeyInflight = (async () => {
    // Authoritative re-read straight from the relays, so we decide against the
    // real event rather than an in-memory copy that may be empty only because a
    // prior fetch timed out.
    const fresh = await loadSettingsDetailed(pubkey, active)

    if (fresh.settings?.mailIndexKey) {
      // Another device already minted one (or our startup load missed it). Adopt
      // it — same key everywhere is the whole point.
      useSettingsStore.getState().update({ mailIndexKey: fresh.settings.mailIndexKey })
      return fresh.settings.mailIndexKey
    }

    if (fresh.eventExists && fresh.settings === null) {
      // A settings event is present but we couldn't decrypt it. Writing now
      // would overwrite it wholesale — refuse, and let a later attempt (once the
      // signer/relay recovers) do it safely.
      throw new Error(
        'settings event exists but could not be read — refusing to mint a mail index key to avoid overwriting it',
      )
    }

    const key = randomMailIndexKey()
    // Merge into the freshly fetched settings (falling back to the in-memory
    // copy only when no event exists) so no other field is lost.
    const base = fresh.settings ?? useSettingsStore.getState().settings
    await useSettingsStore.getState().save({ ...base, mailIndexKey: key }, pubkey, active)
    return key
  })()
  try {
    return await indexKeyInflight
  } finally {
    indexKeyInflight = null
  }
}
