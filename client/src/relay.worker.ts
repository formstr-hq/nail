import {
  RelayService,
  selfChannel,
  IndexedDBStorage,
  defaultPrunePolicy,
} from '@formstr/local-relay'
import { KIND_GIFTWRAP, KIND_SETTINGS } from '@/lib/nostr/constants'

// The default policy protects relay lists (10000-19999) but would evict mail
// gift wraps (1059) after 7 days / past the event cap, and settings (30078)
// likewise. The mailbox lives in these events — never prune them.
const prunePolicy = defaultPrunePolicy()
prunePolicy.protectedKinds.add(KIND_GIFTWRAP)
prunePolicy.protectedKinds.add(KIND_SETTINGS)

// This file compiles in the app's DOM-lib program, so `self` is typed as
// Window; structurally it is the worker scope selfChannel expects.
const channel = selfChannel(
  self as unknown as {
    postMessage: (m: unknown) => void
    onmessage: ((e: MessageEvent) => void) | null
  },
)

const service = new RelayService({
  channel,
  storage: new IndexedDBStorage('nail'),
  persistence: { prunePolicy },
})

void service.start()

export {}
