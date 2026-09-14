import { useEffect, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useSettingsStore } from '@/app/store/settings'
import { useOwnedAddresses } from '@/app/hooks/useOwnedAddresses'
import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import type { PgpKeypair } from '@/app/lib/nostr/settings'
import {
  keyringKey,
  addToKeyring,
  removeFromKeyring,
  keyringEntries,
  type KeyringEntry,
} from '@/app/lib/pgp/keyring'
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
  // always-present npub bridge address.
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

  async function persist(patch: Parameters<typeof save>[0]) {
    if (!account || !active) {
      setError('Your session is locked — sign in again.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await save(patch, account.pubkey, active)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function setAliasKey(address: string, keypair: PgpKeypair | null) {
    const next = { ...(settings.pgpKeys ?? {}) }
    if (keypair) next[keyringKey(address)] = keypair
    else delete next[keyringKey(address)]
    void persist({ pgpKeys: next })
  }

  return (
    <div className="flex flex-col gap-6">
      <Field
        label="Your keys"
        hint="A separate PGP key for each of your addresses — kept distinct so your aliases stay unlinked. Each is used to sign and decrypt mail for that address, and its private half is stored encrypted and synced with your other settings."
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
              onSet={(kp) => setAliasKey(address, kp)}
              setError={setError}
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