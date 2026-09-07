/**
 * Worker entry — the thin platform shell for the local relay. All logic lives in
 * RelayService (shipped by @formstr/local-relay); this just wires it to the real
 * Worker globals: selfChannel(self), the default WebSocket factory, and the
 * IndexedDB store. Spawned from the main thread via
 *   new Worker(new URL('./relay.worker.ts', import.meta.url), { type: 'module' })
 *
 * This is the pattern the working host apps use verbatim. Compiling the entry
 * from source (rather than pointing `new URL` at the package's prebuilt `/worker`
 * subpath) is what makes it resolve under Vite dev as well as build.
 */
/// <reference lib="webworker" />
import { RelayService, selfChannel, IndexedDBStorage } from '@formstr/local-relay'

const channel = selfChannel(
  self as unknown as {
    postMessage: (m: unknown) => void
    onmessage: ((e: MessageEvent) => void) | null
  },
)

const service = new RelayService({
  channel,
  storage: new IndexedDBStorage('mailstr'),
})

// Hydrate from IndexedDB, then begin write-through + pruning. `hydrated` lets the
// main thread know the store is warm (interests declared during boot may have
// EOSE'd on an empty store); our client ignores the frame today but it is the
// documented hook for re-declaring against the cache later.
void service.start().then(() => {
  channel.post({ kind: 'hydrated' })
})

export {}
