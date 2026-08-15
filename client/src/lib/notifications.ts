import { fetchDmRelays } from '@/lib/nostr/relays'

/**
 * Native (Android) background mail notifications. The `Notifier` Capacitor
 * plugin lives only inside the app's WebView; on the web this module is a no-op.
 * We reach it through the runtime global instead of an npm dep so the client
 * build stays Capacitor-free.
 *
 * The plugin schedules a periodic WorkManager poll of the owner's DM relays for
 * new kind-1059 gift-wraps k-tagged as mail (1301) and raises a local
 * notification. Metadata-only — no key, no decryption. See the `notifier` crate.
 */
interface NotifierPlugin {
  start(options: { pubkey: string; relays: string[] }): Promise<void>
  stop(): Promise<void>
  requestPermissions?(): Promise<unknown>
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  Plugins?: { Notifier?: NotifierPlugin }
}

function nativeNotifier(): NotifierPlugin | null {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  return cap.Plugins?.Notifier ?? null
}

// The pubkey the watcher is currently pointed at, so switching accounts
// restarts it and a redundant re-render doesn't re-schedule.
let watching: string | null = null

/**
 * Point the background watcher at `pubkey` (start/restart), or tear it down when
 * `pubkey` is null (logout). No-op on web. Watches the account's kind-10050 DM
 * relays — the same place the inbox reads mail.
 */
export async function syncMailNotifications(pubkey: string | null): Promise<void> {
  const notifier = nativeNotifier()
  if (!notifier) return

  if (!pubkey) {
    watching = null
    try {
      await notifier.stop()
    } catch (err) {
      console.warn('[notifications] stop failed', err)
    }
    return
  }

  if (pubkey === watching) return
  watching = pubkey

  try {
    // No-op on Android < 13; on 13+ it prompts once, then remembers.
    await notifier.requestPermissions?.()
    const relays = await fetchDmRelays(pubkey)
    await notifier.start({ pubkey, relays })
  } catch (err) {
    // A failure just means no background notifications; the app is unaffected.
    watching = null
    console.warn('[notifications] start failed', err)
  }
}
