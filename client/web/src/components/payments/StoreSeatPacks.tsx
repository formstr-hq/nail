import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { fetchSeatPacks, type SeatPack } from '@/lib/payments/store/api'
import { initCatalog } from '@/lib/payments/store/catalog'
import { currentPlatform, getProductInfo } from '@/lib/payments/store/iap'

/** The fixed seat packs a store sells, at the store's own prices. */
export default function StoreSeatPacks({
  onPick,
}: {
  onPick: (seats: number) => void
}) {
  const [packs, setPacks] = useState<Array<SeatPack & { price: string | null }> | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const platform = currentPlatform()
        const all = await fetchSeatPacks()
        await initCatalog()
        if (cancelled) return
        setPacks(
          all
            .filter((p) => p[platform])
            .map((p) => ({ ...p, price: getProductInfo(p[platform]!)?.price ?? null })),
        )
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (failed) return <p className="text-[11.5px] text-subtle">Seat packs are unavailable right now.</p>
  if (!packs) return <Loader2 size={16} className="animate-spin text-gray-300" />
  return (
    <div className="flex flex-wrap gap-2">
      {packs.map((p) => (
        <button
          key={p.seats}
          type="button"
          onClick={() => onPick(p.seats)}
          className="flex min-w-[6.5rem] flex-col items-center rounded-lg border border-border px-3 py-2 text-[13px] hover:bg-muted"
        >
          <span className="font-medium">
            {p.seats} {p.seats === 1 ? 'seat' : 'seats'}
          </span>
          <span className="font-mono text-[12px] text-subtle">{p.price ?? '—'}</span>
        </button>
      ))}
    </div>
  )
}
