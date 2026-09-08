import { useEffect, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { BRIDGE_DOMAIN } from '@/app/lib/nostr/constants'

// Sentinel select value for "type your own address" — kept distinct from any
// real address string so it can never collide with an owned/bridge option.
const CUSTOM_SENDER = '__custom__'

/**
 * The Sender-address picker's draft state, extracted from SettingsModal
 * (audit C2: a `useState` seed of store data with a manual re-sync effect).
 *
 * The picker offers the owned addresses + the npub bridge address as fixed
 * options, plus a Custom free-text mode. The sync-back effect re-classifies
 * the mode when `addresses` resolves after mount — but only while the user
 * hasn't touched the picker, so an in-progress edit is never clobbered.
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

  const initialSenderAddress = savedSenderAddress ?? ''
  const [senderAddress, setSenderAddress] = useState(initialSenderAddress)
  // Tracks which <select> option is active: a fixed option's own value, or
  // CUSTOM_SENDER when the free-text input is in play. Derived from the
  // saved value each render (which in practice doesn't change while this
  // modal is open) — if that value isn't one of the fixed options (own
  // addresses may still be loading), it falls into Custom rather than being
  // reset, per the "never regress a saved address" invariant.
  const [senderMode, setSenderMode] = useState<string>(() =>
    senderOptions.includes(initialSenderAddress) ? initialSenderAddress : CUSTOM_SENDER,
  )

  // `addresses` loads asynchronously — on first open, the mount-time
  // initializer above almost always sees `addresses === []` and falls back
  // to Custom even when the saved address is one of the user's own. Once the
  // fetch resolves, re-classify — but only if the user hasn't touched the
  // picker since mount (still on Custom with the original saved value),
  // so an in-progress edit is never clobbered.
  useEffect(() => {
    if (
      senderMode === CUSTOM_SENDER &&
      senderAddress === initialSenderAddress &&
      senderOptions.includes(senderAddress)
    ) {
      setSenderMode(senderAddress)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, bridgeAddress])

  function handleSenderModeChange(value: string) {
    setSenderMode(value)
    if (value !== CUSTOM_SENDER) setSenderAddress(value)
  }

  return {
    senderOptions,
    senderAddress,
    setSenderAddress,
    senderMode,
    handleSenderModeChange,
  }
}

export function useBridgeAddress() {
  const account = useAccountStore((s) => s.account)
  return account ? `${account.npub}@${BRIDGE_DOMAIN}` : ''
}