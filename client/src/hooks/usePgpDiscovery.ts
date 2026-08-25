import { useEffect, useRef, useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { addressesMissingKeys, addToKeyring, hasAnyOwnKey } from '@/lib/pgp/keyring'
import { lookupByEmail } from '@/lib/pgp/keyserver'

/**
 * Automatic key discovery for the composer.
 *
 * Manual import is the fallback, not the common path — this is what makes
 * "have a key ⇒ encrypt" happen without the user doing anything. For each
 * recipient we don't yet hold a key for, it queries the keyserver; a hit is
 * saved into the synced keyring, which flips `canEncrypt` on in the composer
 * exactly as a manual import would.
 *
 * Care taken:
 *  - only email-shaped, keyless recipients are looked up (npubs and addresses
 *    we already have keys for are skipped);
 *  - each address is looked up at most once per session (`attempted`), so
 *    typing doesn't hammer the keyserver, which rate-limits by-email hard;
 *  - a miss or an error is silent — discovery never blocks or errors the
 *    compose flow, it just leaves that recipient without a key (→ cleartext).
 *
 * Returns whether a lookup is currently in flight, so the UI can show a subtle
 * "looking for keys…" state instead of a flicker between cleartext and encrypted.
 */
export function usePgpDiscovery(recipients: string[]): { discovering: boolean } {
  const { account, active } = useAccountStore()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const [discovering, setDiscovering] = useState(false)
  // Addresses already looked up this session — never retried, hit or miss.
  const attempted = useRef<Set<string>>(new Set())

  const hasOwnKey = hasAnyOwnKey(settings)

  useEffect(() => {
    // No point discovering correspondents' keys if we can't encrypt anyway.
    if (!hasOwnKey || !account || !active || recipients.length === 0) return

    const missing = addressesMissingKeys(
      { pgpKeyring: settings.pgpKeyring, pgpKeys: settings.pgpKeys },
      recipients,
    )
      // Only real email addresses are on a keyserver; skip npubs and anything
      // that isn't address-shaped, and anything we've already tried.
      .filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a) && !attempted.current.has(a.toLowerCase()))

    if (missing.length === 0) return

    let alive = true
    setDiscovering(true)
    void (async () => {
      let keyring = settings.pgpKeyring
      let found = false
      for (const address of missing) {
        attempted.current.add(address.toLowerCase())
        const armored = await lookupByEmail(address)
        if (!alive) return
        if (armored) {
          try {
            keyring = await addToKeyring(keyring, armored, address)
            found = true
          } catch {
            // A key that won't parse into the ring is treated as a miss.
          }
        }
      }
      if (alive && found) {
        // Persist the enriched keyring so the discovered keys sync and the
        // composer re-gates to "can encrypt". Best-effort — a save failure just
        // means we rediscover next time.
        try {
          await save({ ...settings, pgpKeyring: keyring }, account.pubkey, active)
        } catch (e) {
          console.warn('[pgp] failed to persist discovered keys', e)
        }
      }
      if (alive) setDiscovering(false)
    })()

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipients.join(','), hasOwnKey, account?.pubkey])

  return { discovering }
}
