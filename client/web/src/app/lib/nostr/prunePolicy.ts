import { defaultPrunePolicy, type PrunePolicy } from '@formstr/local-relay'
import { KIND_GIFTWRAP, KIND_MAIL_META, KIND_SETTINGS } from './constants'

/**
 * Local-relay cache retention for the mail app.
 *
 * The package default protects profiles (0), contacts (3), relay lists
 * (10000–19999) and ages out everything else at `defaultTtlSeconds` (7 days),
 * with a 50k hard cap that evicts oldest-first. Mail ciphertext is kind-1059
 * gift wraps, which is NOT protected — so the package default silently deletes
 * the user's offline mailbox a week after it arrives. That is exactly the
 * "my local mail vanished" failure: the IndexedDB replay (which serves mail
 * before any relay answers) is the thing that drops it.
 *
 * These kinds are never an acceptable automatic deletion. Mail is removed only
 * by the user's own delete action (the device tombstone + NIP-09), never by a
 * cache-eviction timer:
 *
 *  - `KIND_GIFTWRAP` (1059) — the mail/DM ciphertext itself (the offline mailbox).
 *  - `KIND_MAIL_META` (34578) — read/archived/trashed state carried across devices.
 *  - `KIND_SETTINGS` (30078) — the account's mail settings.
 *
 * PROTECTING THEM AFFECTS THE LOCAL STORE ONLY. Prune never publishes to
 * relays (`EventDB.remove` only notifies local persistence + drops outbox
 * debt), so this cannot delete — or resurrect — anything upstream. It only
 * stops the device forgetting.
 *
 * NOTE: this is a client-side override of the upstream default. The durable fix
 * belongs in `@formstr/local-relay`'s `defaultPrunePolicy` (or a per-kind
 * protection the host opts into); until then every host app must pass this.
 */
export function mailPrunePolicy(): PrunePolicy {
  const base = defaultPrunePolicy()
  const protectedKinds = new Set(base.protectedKinds)
  protectedKinds.add(KIND_GIFTWRAP)
  protectedKinds.add(KIND_MAIL_META)
  protectedKinds.add(KIND_SETTINGS)
  return { ...base, protectedKinds }
}
