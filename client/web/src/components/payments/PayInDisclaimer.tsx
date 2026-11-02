/**
 * The card disclosure lives on the first panel, before the buyer commits, so
 * the pay step can skip the intermediate confirmation screen.
 */
export default function PayInDisclaimer({ payIn }: { payIn: string }) {
  if (payIn === 'sats') return null
  return (
    <p className="mt-3 text-center text-[11px] leading-relaxed text-gray-400">
      Card purchases are sold through Stripe (Link). Stripe may see your IP address and payment
      details; we never see your card.
    </p>
  )
}
