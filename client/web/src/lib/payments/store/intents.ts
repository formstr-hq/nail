/**
 * What a purchase was for, remembered on the device until it is verified.
 *
 * A seat pack's store receipt says which SKU was bought but not which domain
 * it is for, and a mailbox receipt does not say which address. If the app is
 * killed between the store charging and our verify, the start-up sweep needs
 * that detail to finish the job, so it is written before the store sheet opens.
 */
export interface PurchaseIntent {
  nip05?: string
  tierId?: string
  pubkey?: string
  domain?: string
}

const KEY = 'mailstr.pay.intents'

function read(): Record<string, PurchaseIntent> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, PurchaseIntent>) : {}
  } catch {
    return {}
  }
}

function write(value: Record<string, PurchaseIntent>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    // storage unavailable: the sweep then relies on the backend's own records
  }
}

export function rememberIntent(productId: string, intent: PurchaseIntent): void {
  write({ ...read(), [productId]: intent })
}

export function recallIntent(productId: string): PurchaseIntent | undefined {
  return read()[productId]
}

export function forgetIntent(productId: string): void {
  const all = read()
  delete all[productId]
  write(all)
}
