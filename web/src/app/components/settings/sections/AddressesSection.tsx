import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'
import { buyAddressUrl } from '@/lib/buyAddress'
import { Button } from '@/app/components/ui/Button'
import { AlertIcon, PlusIcon } from '@/app/components/ui/icons'
import { Field, inputClass } from '@/app/components/settings/Field'

// Sentinel select value for "type your own address" — kept distinct from any
// real address string so it can never collide with an owned/bridge option.
export const CUSTOM_SENDER = '__custom__'

export interface AddressesSectionProps {
  hasAccount: boolean
  addresses: string[]
  addressesLoading: boolean
  addressesError: string
  reloadAddresses: () => void
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
          {/* Purchasing lives in the landing app (the tier/invoice/payment
      flow only exists there); we deep-link with ?buy=1, which
      opens its wizard in purchase mode and suppresses its own
      returning-owner redirect so it can't bounce back here.
      We also stash the intent in shared same-origin storage: the
      Android webview can drop the query string when opening the
      link, in which case the landing reads this flag instead. */}
          <a
            href={buyAddressUrl()}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              try {
                localStorage.setItem('mailstr.buyIntent', '1')
              } catch {
                // storage unavailable — the ?buy=1 param alone carries it
              }
            }}
            className="mt-1 inline-flex h-8 items-center justify-center gap-2 self-start whitespace-nowrap rounded-md border border-primary bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors duration-[120ms] hover:bg-primary/90"
          >
            <PlusIcon className="h-4 w-4" />
            Buy a new address
          </a>
          <p className="text-[11px] leading-relaxed text-subtle">
            Opens the signup page in a new tab. New addresses appear here once paid —
            reload the list with “Try again”.
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