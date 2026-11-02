import { AlertTriangle, Loader2 } from 'lucide-react'

/** "Confirming your payment…": the client waits for the backend, never its own belief. */
export function Confirming() {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <Loader2 size={22} className="animate-spin text-gray-400" />
      <p className="text-sm font-semibold text-ink">Confirming your payment…</p>
      <p className="text-xs text-gray-500">This usually takes a few seconds. Don't close this window.</p>
    </div>
  )
}

/** The bounded wait ran out. The webhook and the reconcile cron finish the job. */
export function StillConfirming({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <p className="text-sm font-semibold text-ink">Still confirming your payment…</p>
      <p className="max-w-xs text-xs leading-relaxed text-gray-500">
        You can close this window. Your purchase will appear shortly. If it hasn't shown up after
        an hour, contact us from <span className="font-medium text-gray-600">Settings → Help</span>.
      </p>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-black/10 px-4 py-2 text-sm font-semibold text-ink hover:bg-black/[0.04]"
        >
          Close
        </button>
      )}
    </div>
  )
}

/** Paid, but the purchase could not be created. A terminal error, never a spinner. */
export function NeedsAttention({ reason }: { reason?: string }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p className="inline-flex items-center gap-2 font-semibold">
        <AlertTriangle size={16} /> Your payment went through, but we couldn't finish your order.
      </p>
      {reason && <p className="text-red-700">{reason}</p>}
      <p className="text-xs text-red-700">
        We've been alerted and will refund you or offer an alternative. Contact us from{' '}
        <span className="font-medium">Settings → Help</span> if you don't hear back.
      </p>
    </div>
  )
}
