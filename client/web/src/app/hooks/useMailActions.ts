import { useCallback } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useSettingsStore } from '@/app/store/settings'
import { useMailStore } from '@/app/store/mail'
import { publishMailMeta, randomMailIndexKey } from '@/app/lib/nostr/mailMeta'
import { publishGiftwrapDeletion } from '@/app/lib/nostr/delete'
import { loadSettingsDetailed } from '@/app/lib/nostr/settings'
import type { MailFlags } from '@/app/types/mail'
import { isCurrentSession, sessionEpoch } from '@/app/store/sessionEpoch'

/**
 * The single in-flight index-key bootstrap, shared across every hook instance
 * and scoped to one account.
 *
 * The HMAC secret is minted lazily on the first action that needs it. Two
 * actions firing before the first save lands would otherwise each generate a key
 * and race their saves, leaving half our state under an orphaned coordinate.
 * Funnelling every caller through one promise makes the mint happen exactly once.
 *
 * Keyed by pubkey: an in-flight mint for a previous account must never be
 * handed to the account that just logged in (audit B2).
 */
let indexKeyInflight: { pubkey: string; promise: Promise<string> } | null = null

/**
 * Archive / trash / read actions on a mail.
 *
 * Each is optimistic: the local flag flips immediately (so the list re-files at
 * Archive / trash / read actions on a mail.
 *
 * Each is optimistic: the local flag flips immediately (so the list re-files at
 * once) and the kind-34578 metadata event is published in the background. A
 * failed publish sets `mailStore.syncError`, shown as a dismissible app-level
 * banner; the local change stands and the next successful action (or a reload
 * that re-reads the relay) reconciles it (audit B3).
 */
export function useMailActions() {
  const setFlag = useMailStore((s) => s.setFlag)

  const apply = useCallback(
    (id: string, patch: Partial<Omit<MailFlags, 'updatedAt'>>) => {
      const { account, active } = useAccountStore.getState()
      if (!account || !active) return

      // A deleted mail is gone: a later archive/read/trash would only publish
      // state events pointing at a tombstone. Delete is final. The tombstone
      // lives in `deletedIds` (a deleted flag in `mailState` is legacy).
      const store = useMailStore.getState()
      if (store.deletedIds.has(id) || store.mailState[id]?.deleted) return

      // No-op if the mail is already in the requested state — avoids a needless
      // relay write on, e.g., re-opening an already-read message.
      const current = useMailStore.getState().mailState[id]
      if (current && (Object.keys(patch) as (keyof typeof patch)[]).every((k) => current[k] === patch[k])) {
        return
      }

      const merged = setFlag(id, patch)
      // A publish that straddles a logout/switch must not write a sync error
      // (or clear one) into the incoming account's store.
      const session = sessionEpoch()

      void (async () => {
        try {
          const indexKey = await ensureMailIndexKey(account.pubkey, active)
          await publishMailMeta(id, merged, account.pubkey, active, indexKey)
          if (!isCurrentSession(session)) return
          // A later success clears an earlier failure: sync recovered.
          useMailStore.getState().setSyncError(null)
        } catch (e) {
          console.error('[mailMeta] failed to publish mail state', e)
          if (!isCurrentSession(session)) return
          // Surface it: the local flag stands, but cross-device sync is now
          // degraded and the user deserves to know (audit B3).
          useMailStore
            .getState()
            .setSyncError(
              'Saved on this device, but syncing to your other devices failed. It will retry on your next action.',
            )
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

    /**
     * Permanent delete. The mail vanishes locally at once (tombstoned so no
     * relay replay resurrects it); in the background we publish the meta
     * `deleted` flag — the cross-device record — and BOTH NIP-09 kind-5
     * variants (see lib/nostr/delete.ts): the wrap-author one, which NIP-09
     * relays and our own local cache actually honor, and the recipient one,
     * the only attempt possible for legacy mail without an embedded wrap key.
     */
    deleteForever: useCallback((id: string) => {
      const { account, active } = useAccountStore.getState()
      if (!account || !active) return
      const deleteStore = useMailStore.getState()
      if (deleteStore.deletedIds.has(id) || deleteStore.mailState[id]?.deleted) return

      // Read the wrap key before markDeleted purges it.
      const wrapSecret = useMailStore.getState().wrapKeys[id]
      const merged = useMailStore.getState().markDeleted(id)
      const session = sessionEpoch()

      void (async () => {
        try {
          const indexKey = await ensureMailIndexKey(account.pubkey, active)
          await publishMailMeta(id, merged, account.pubkey, active, indexKey)
          if (isCurrentSession(session)) useMailStore.getState().setSyncError(null)
        } catch (e) {
          console.error('[delete] failed to publish deleted state', e)
          if (isCurrentSession(session)) {
            useMailStore
              .getState()
              .setSyncError(
                'Deleted on this device, but syncing the deletion to your other devices failed.',
              )
          }
        }
        try {
          await publishGiftwrapDeletion({
            giftwrapId: id,
            wrapSecret,
            pubkey: account.pubkey,
            active,
          })
        } catch (e) {
          // Local removal stands; a failed relay round just means relays keep
          // ciphertext they cannot read, and the tombstone keeps it hidden.
          console.error('[delete] failed to publish NIP-09 deletion', e)
        }
      })()
    }, []),
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
  if (indexKeyInflight?.pubkey === pubkey) return indexKeyInflight.promise

  const promise = (async () => {
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
    // Seed the store with what the authoritative fetch returned before the
    // patch save, so fields the live store has not seen (a startup load that
    // timed out) are not lost when save merges its patch into it.
    if (fresh.settings) useSettingsStore.getState().update(fresh.settings)
    // save() commits to the store only after the publish is accepted, so the
    // key below is durable — or this throws and no coordinate is written (B5).
    await useSettingsStore.getState().save({ mailIndexKey: key }, pubkey, active)
    return key
  })()
  indexKeyInflight = { pubkey, promise }
  try {
    return await promise
  } finally {
    if (indexKeyInflight?.promise === promise) indexKeyInflight = null
  }
}
