import { useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'

// Sentinel select value for "type your own address" — kept distinct from any
// real address string so it can never collide with an owned/bridge option.
// Exported so the AddressesSection <select> and this hook share ONE value;
// a second copy was the kind of drift the audit flags.
export const CUSTOM_SENDER = '__custom__'

/**
 * The Sender-address picker's draft state, extracted from SettingsModal
 * (audit C2: a `useState` seed of store data with a manual re-sync effect).
 *
 * The picker offers the owned addresses + the npub bridge address as fixed
 * options, plus a Custom free-text mode. `senderMode` is DERIVED from the
 * typed address and the option list rather than synced by an effect: while the
 * typed value equals the saved one and the option list is still loading, the
 * effective mode is "custom"; once the option resolves, the same value is
 * recognized as a fixed option automatically. An in-progress edit therefore
 * never needs clobber-protection — its mode simply follows what was typed.
 */
export function useSenderDraft(input: {
  addresses: string[]
  bridgeAddress: string
  savedSenderAddress?: string
}) {
  const { addresses, bridgeAddress, savedSenderAddress } = input

  // Every account has a working inbound bridge address derived from its
  // npub — always offered as an option regardless of purchased names.
  const senderOptions = bridgeAddress ? [...addresses, bridgeAddress] : addresses

  const [senderAddress, setSenderAddressState] = useState(savedSenderAddress ?? '')
  // Explicit mode pick, when the user has made one. Null means "derive it":
  // the saved/typed value is a fixed option once the list contains it.
  const [pickedMode, setPickedMode] = useState<string | null>(null)

  const derivedMode =
    pickedMode ??
    (senderOptions.includes(senderAddress) ? senderAddress : CUSTOM_SENDER)

  function setSenderAddress(value: string) {
    // Typing a free-text address means the mode is Custom, even if the string
    // later happens to match an option.
    setPickedMode(null)
    setSenderAddressState(value)
  }

  function handleSenderModeChange(value: string) {
    setPickedMode(value)
    if (value !== CUSTOM_SENDER) setSenderAddressState(value)
  }

  return {
    senderOptions,
    senderAddress,
    setSenderAddress,
    senderMode: derivedMode,
    handleSenderModeChange,
  }
}

export function useBridgeAddress() {
  const account = useAccountStore((s) => s.account)
  return account ? `${account.npub}@${BRIDGE_DOMAIN}` : ''
}
