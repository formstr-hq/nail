import { useEffect, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useSettingsStore } from '@/app/store/settings'
import { useOwnedAddresses } from '@/app/hooks/useOwnedAddresses'
import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import type { PgpKeypair } from '@/app/lib/nostr/settings'
import { keyringKey, addToKeyring, removeFromKeyring, keyringEntries, type KeyringEntry } from '@/app/lib/pgp/keyring'
import { installAliasKey } from '@/app/lib/pgp/install'
import { republishOwnKey } from '@/app/components/settings/pgp/wkdPublish'
import { AlertIcon } from '@/app/components/ui/icons'
import { Field } from '@/app/components/settings/pgp/Field'
import { AliasKeyRow } from '@/app/components/settings/pgp/AliasKeyRow'
import { Keyring } from '@/app/components/settings/pgp/Keyring'

/**
 * The Encryption settings pane: manage a PGP key PER ALIAS plus the keyring of
 * correspondents' public keys.
 *
 * Keys are per-alias by design (settings.ts): one key bound to several
 * addresses would link them publicly, which is the opposite of what aliases are
 * for. So each owned address gets its own independent keypair, listed and
 * managed separately here.
 *
 * This owns its own persistence (through the settings store's `save`) rather
 * than folding into SettingsModal's single Save, because generating/importing a
 * key or editing the keyring is each a complete action the user expects to stick
 * immediately. Private keys ride in the same encrypted settings blob as every
 * other field.
 */
export function PgpSettings() {
  const { account, active } = useAccountStore()
  const { settings, save } = useSettingsStore()
  const { addresses } = useOwnedAddresses()

  const [entries, setEntries] = useState<KeyringEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Every address the user can hold a key for: owned NIP-05 names plus the
  // always-present npub bridge address. The npub row is DISABLED for PGP: it
  // is not a nip05 identity (`nostr.json?name=npub…` has no entry), so the
  // backend's ownership check rejects its WKD publish with 403 every time —
  // and by policy (install.ts) a key whose publish fails is not kept.
  const bridgeAddress = account ? `${account.npub}@${BRIDGE_DOMAIN}` : ''
  const aliasList = [...addresses, ...(bridgeAddress ? [bridgeAddress] : [])]

  useEffect(() => {
    let alive = true
    void (async () => {
      const list = await keyringEntries(settings.pgpKeyring)
      if (alive) setEntries(list)
    })()
    return () => {
      alive = false
    }
  }, [settings.pgpKeyring])

  async function persist(patch: Parameters<typeof save>[0]): Promise<boolean> {
    if (!account || !active) {
      setError('Your session is locked — sign in again.')
      return false
    }
    setBusy(true)
    setError('')
    try {
      await save(patch, account.pubkey, active)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  /**
   * Store an alias keypair through the install orchestrator
   * (lib/pgp/install.ts): save, then publish; a publish failure rolls the save
   * back, so a WKD failure never leaves a key behind. A rollback failure is
   * the one case where the key IS stored without a publish — surfaced with the
   * Republish hint, which retries the key actually in settings.
   *
   * Returns whether the key was installed, so a caller (the import form) can
   * keep itself open on failure. The failure message is set here, once.
   */
  async function installKey(address: string, keypair: PgpKeypair): Promise<boolean> {
    if (!account || !active) {
      setError('Your session is locked — sign in again.')
      return false
    }
    setBusy(true)
    setError('')
    try {
      const result = await installAliasKey({
        address,
        keypair,
        // Fresh generate: nothing to restore if the publish fails, so the
        // rollback removes the entry.
        previous: undefined,
        // Read the LIVE pgpKeys at save time, not the snapshot from this
        // render: key generation runs for ~a second, and a concurrent change
        // to another alias's key must not be clobbered by this patch. `null`
        // removes the alias entry (the rollback path).
        save: (kp) => {
          const live = { ...(useSettingsStore.getState().settings.pgpKeys ?? {}) }
          if (kp) live[keyringKey(address)] = kp
          else delete live[keyringKey(address)]
          return save({ pgpKeys: live }, account.pubkey, active)
        },
        publish: async (addr, keys) => republishOwnKey(addr, keys),
      })
      if (result.status === 'failed') {
        setError(
          result.saved
            ? `Key wasn't published: ${result.error}. Use "Republish to WKD" to retry.`
            : `Key generation failed, nothing was saved: ${result.error}`,
        )
        return false
      }
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  /**
   * Replace an alias's key, restoring the previous keypair if the publish
   * fails (so rotation is all-or-nothing and old mail stays readable).
   */
  async function rotateKey(address: string, keypair: PgpKeypair): Promise<boolean> {
    if (!account || !active) {
      setError('Your session is locked — sign in again.')
      return false
    }
    setBusy(true)
    setError('')
    try {
      const result = await installAliasKey({
        address,
        keypair,
        previous: useSettingsStore.getState().settings.pgpKeys?.[keyringKey(address)],
        save: (kp) => {
          const live = { ...(useSettingsStore.getState().settings.pgpKeys ?? {}) }
          if (kp) live[keyringKey(address)] = kp
          else delete live[keyringKey(address)]
          return save({ pgpKeys: live }, account.pubkey, active)
        },
        publish: async (addr, keys) => republishOwnKey(addr, keys),
      })
      if (result.status === 'failed') {
        setError(
          result.saved
            ? `Key wasn't rotated: ${result.error}. The new key is stored but unpublished — use "Republish to WKD".`
            : `Key rotation failed, the previous key is still in place: ${result.error}`,
        )
        return false
      }
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Field
        label="Your keys"
        hint="A separate PGP key for each of your addresses — kept distinct so your aliases stay unlinked. Each is used to sign and decrypt mail for that address, and its private half is stored unlocked (no passphrase) and synced with your other settings. Rotate replaces the key and makes previously encrypted messages unreadable."
      >
        <div className="flex flex-col gap-2">
          {aliasList.length === 0 && (
            <p className="text-[11.5px] text-subtle">
              Set up an address first — keys are bound to an email identity.
            </p>
          )}
          {aliasList.map((address) => (
            <AliasKeyRow
              key={address}
              address={address}
              keypair={settings.pgpKeys?.[keyringKey(address)]}
              busy={busy}
              onInstall={(kp) => installKey(address, kp)}
              onRotate={(kp) => rotateKey(address, kp)}
              setError={setError}
              disabledReason={
                bridgeAddress && address === bridgeAddress
                  ? 'Encryption is unavailable for the npub bridge address — it has no NIP-05 identity, so a public key cannot be published for it.'
                  : undefined
              }
            />
          ))}
        </div>
      </Field>

      <Field
        label="Correspondents’ keys"
        hint="Public keys of people you write to, found automatically when you compose or added by hand. You can only encrypt to someone once you hold their key."
      >
        <Keyring
          entries={entries}
          busy={busy}
          onAdd={async (armored, forAddress) => {
            const next = await addToKeyring(settings.pgpKeyring, armored, forAddress || undefined)
            await persist({ pgpKeyring: next })
          }}
          onRemove={(address) => void persist({ pgpKeyring: removeFromKeyring(settings.pgpKeyring, address) })}
          setError={setError}
        />
      </Field>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
          <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
          <p className="text-[11.5px] leading-relaxed text-destructive">{error}</p>
        </div>
      )}
    </div>
  )
}