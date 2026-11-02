import type { Nip98Signer } from '@/lib/nip98'
import { initCatalog } from './catalog'
import { sweepPending } from './flow'

/**
 * On app start, finish any purchase the store charged for but we never
 * confirmed (the app was killed mid-purchase). The backend answers a replay
 * with `already_provisioned`, so running this every start is safe.
 */
export async function runStoreSweep(signer: Nip98Signer): Promise<void> {
  try {
    await initCatalog()
    await sweepPending(signer)
  } catch (err) {
    console.warn('store purchase sweep skipped:', err)
  }
}
