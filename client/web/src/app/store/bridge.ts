import { create } from 'zustand'
import type { BridgeProbe } from '@/app/lib/nostr/bridge'
import type { Nip05State } from '@/app/lib/nostr/nip05'

interface BridgeState {
  /**
   * The live resolution state of every configured bridge. Empty until the
   * first resolution pass starts. Never persisted: a cached answer would
   * freeze the exact verdict this store exists to keep live.
   */
  probes: BridgeProbe[]
  /**
   * NIP-05 verdicts for sender addresses, keyed by lowercased address. Shared
   * and live, so a verdict landing mid-render is just another store update
   * that every consumer re-derives from — rather than a value frozen when the
   * message was first displayed.
   */
  nip05: Record<string, Nip05State>
  /** Replace the probe set (a new resolution pass for new targets). */
  setProbes: (probes: BridgeProbe[]) => void
  /** Merge one probe transition, preserving target order. */
  upsertProbe: (probe: BridgeProbe) => void
  setNip05: (address: string, state: Nip05State) => void
  reset: () => void
}

export const useBridgeStore = create<BridgeState>()((set) => ({
  probes: [],
  nip05: {},

  setProbes: (probes) => set({ probes }),

  upsertProbe: (probe) =>
    set((s) => {
      const i = s.probes.findIndex(
        (p) => p.target.toLowerCase() === probe.target.toLowerCase(),
      )
      if (i === -1) return { probes: [...s.probes, probe] }
      const probes = [...s.probes]
      probes[i] = probe
      return { probes }
    }),

  setNip05: (address, state) =>
    set((s) => {
      const key = address.toLowerCase()
      const prev = s.nip05[key]
      // Identical verdict: keep the same object so subscribers don't re-render
      // on a redelivered answer (several mounted consumers probe one address).
      if (
        prev &&
        prev.status === state.status &&
        (prev.status !== 'resolved' ||
          state.status !== 'resolved' ||
          prev.pubkey === state.pubkey)
      ) {
        return s
      }
      return { nip05: { ...s.nip05, [key]: state } }
    }),

  reset: () => set({ probes: [], nip05: {} }),
}))
