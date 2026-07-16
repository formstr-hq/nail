import { DataLayer, LocalRelayClient, workerChannel } from '@formstr/local-relay'
import type { ActiveSigner } from '@formstr/signer'
import { DEFAULT_RELAYS } from './constants'

// The local relay: an IndexedDB-backed event cache + upstream sync engine
// running in a Web Worker. The app declares interests (observe) and publishes;
// the worker owns all relay networking. Recipient-targeted gift-wrap publishes
// do NOT go through here (see relays.ts) — the worker routes p-tags via
// NIP-65 kind-10002 lists, not the NIP-17 kind-10050 lists mail delivery needs.

let dataLayer: DataLayer | null = null

// Signer is injected by the account lifecycle rather than imported from the
// account store, so this module stays store-agnostic and cycle-free.
let signer: ActiveSigner | null = null

export function setLocalRelaySigner(active: ActiveSigner | null): void {
  signer = active
}

export function getLocalRelay(): DataLayer {
  if (dataLayer) return dataLayer

  const worker = new Worker(new URL('../../relay.worker.ts', import.meta.url), {
    type: 'module',
  })
  const client = new LocalRelayClient(workerChannel(worker), {
    // NIP-42 AUTH challenges from upstream relays; null refuses (pre-login).
    onSignRequest: async (template) => {
      if (!signer) return null
      try {
        return await signer.signEvent(template)
      } catch {
        return null
      }
    },
  })

  dataLayer = new DataLayer({
    client,
    sign: async (template) => {
      if (!signer) throw new Error('No active signer')
      return signer.signEvent(template)
    },
  })

  // Bootstrap relay set until the user's kind-10050 list is discovered.
  dataLayer.setUserRelays(DEFAULT_RELAYS)

  return dataLayer
}
