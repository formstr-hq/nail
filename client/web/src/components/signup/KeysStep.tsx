import { PartyPopper } from 'lucide-react'
import { config } from '@/lib/config'

/** Step 4 — the address is claimed; hand off to the inbox or the caller. */
export function KeysStep({
  address,
  embedded,
  onDone,
}: {
  address: string
  /** True in the mail client's buy modal: the parent closes the wizard. */
  embedded: boolean
  onDone: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <PartyPopper size={40} className="text-primary" />
      <p className="text-lg font-bold text-ink">{address} is yours.</p>
      <p className="text-sm text-gray-500">
        {embedded
          ? "It's linked to this account and will appear in your address lists."
          : 'Next: your inbox.'}
      </p>
      <button
        type="button"
        onClick={onDone}
        className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary/90"
      >
        {embedded ? 'Done' : 'Open your inbox →'}
      </button>
    </div>
  )
}

/** Step 5 (landing only) — the final "taking you to your inbox" screen. */
export function DoneStep({ address }: { address: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <PartyPopper size={40} className="text-primary" />
      <p className="text-lg font-bold text-ink">{address} is yours.</p>
      <p className="text-sm text-gray-500">
        Mail sent there now arrives encrypted to your key.{' '}
        <a href={config.mailsUrl} className="font-semibold text-primary">
          Open your inbox →
        </a>
      </p>
    </div>
  )
}
