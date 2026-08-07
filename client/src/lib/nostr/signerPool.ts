import { SimplePool } from 'nostr-tools'

/**
 * A SimplePool used solely as the NIP-46 signer's transport — talking to a
 * remote bunker over its own relay. It is deliberately separate from the
 * mailbox's data layer, which reads and writes through the local relay worker
 * (see `localRelay.ts`): the signer needs a plain pool of its own, and nothing
 * else in the app should reach for one.
 */
let pool: SimplePool | null = null

export function getSignerPool(): SimplePool {
  if (!pool) pool = new SimplePool()
  return pool
}
