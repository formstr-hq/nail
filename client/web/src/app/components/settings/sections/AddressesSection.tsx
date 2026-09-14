import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import { Button } from '@/app/components/ui/Button'
import { AlertIcon, PlusIcon } from '@/app/components/ui/icons'
import { Field, inputClass } from '@/app/components/settings/Field'
import { CUSTOM_SENDER } from '@/app/hooks/useSenderDraft'

export interface AddressesSectionProps {
  hasAccount: boolean
  addresses: string[]
  addressesLoading: boolean
  addressesError: string
  reloadAddresses: () => void
  /** Open the in-app buy-address modal (no more new-tab deep link). */
  onBuyAddress: () => void
  /** Fixed select options: owned addresses + the npub bridge address. */
  senderOptions: string[]
  senderMode: string
  senderAddress: string
  onSenderModeChange: (value: string) => void
  onSenderAddressChange: (value: string) => void
}

/** The Addresses pane: owned NIP-05 names plus the From/sender picker. */
export function AddressesSection(props: AddressesSectionProps) {
  const {
    hasAccount,
    addresses,
    addressesLoading,
    addressesError,
    reloadAddresses,
    onBuyAddress,
    senderMode,
    senderAddress,
    onSenderModeChange,
    onSenderAddressChange,
  } = props
  const placeholder = `you@${BRIDGE_DOMAIN}`

  return (
    <>
      {hasAccount && (
        <Field
          label="Your addresses"
          hint={`Addresses linked to your account on ${BRIDGE_DOMAIN}.`}
        >
          {addressesLoading && (
            <p className="text-[11.5px] text-subtle">Loading your addresses…</p>
          )}
          {!addressesLoading && addressesError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
              <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
              <p className="flex-1 text-[11.5px] leading-relaxed text-destructive">
                {addressesError}
              </p>
              <Button size="sm" onClick={reloadAddresses} className="flex-none">
                Try again
              </Button>
            </div>
          )}
          {!addressesLoading && !addressesError && addresses.length === 0 && (
            <p className="text-[11.5px] text-subtle">
              No addresses yet. Your npub address always works — buy a name below.
            </p>
          )}
          {!addressesLoading && !addressesError && addresses.length > 0 && (
            <div className="flex flex-col gap-1">
              {addresses.map((addr) => (
                <code
                  key={addr}
                  className="block w-full min-w-0 truncate rounded-md border border-input bg-muted px-3 py-2 font-mono text-[11px]"
                >
                  {addr}
                </code>
              ))}
            </div>
          )}
          {/* The purchase wizard embeds in place now (route /mails/buy) —
              no new-tab deep link, no buyIntent stash for the landing to
              read back. Completed purchases refresh this list through the
              shared owned-addresses reload tick. */}
          <Button size="md" onClick={onBuyAddress} className="mt-1 self-start">
            <PlusIcon className="h-4 w-4" />
            Buy a new address
          </Button>
          <p className="text-[11px] leading-relaxed text-subtle">
            New addresses appear here once paid — reload the list with “Try again”
            if one is missing.
          </p>
        </Field>
      )}

      <Field label="Sender address" hint="Shown as the From address on mail you send.">
        <select
          value={senderMode}
          onChange={(e) => onSenderModeChange(e.target.value)}
          className={inputClass}
        >
          {props.senderOptions.map((addr) => (
            <option key={addr} value={addr}>
              {addr}
            </option>
          ))}
          <option value={CUSTOM_SENDER}>Custom…</option>
        </select>
        {senderMode === CUSTOM_SENDER && (
          <input
            value={senderAddress}
            onChange={(e) => onSenderAddressChange(e.target.value)}
            placeholder={placeholder}
            className={inputClass}
          />
        )}
      </Field>
    </>
  )
}