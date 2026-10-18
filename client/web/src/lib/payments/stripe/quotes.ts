import { requestQuote, type Quote, type QuoteRequest } from './api'

const TTL_MS = 60_000

interface Entry {
  at: number
  quote: Promise<Quote>
}
const cache = new Map<string, Entry>()

const keyOf = (r: QuoteRequest) =>
  r.product === 'mail' ? `mail|${r.currency}|${r.tierId}` : `workspace|${r.currency}|${r.seats}`

/**
 * A quote used only to show an indicative price. Shared and kept briefly so
 * several price labels (tier cards, the seats total) cost one request; the
 * binding price is always a fresh quote accepted on the pay step.
 */
export function indicativeQuote(request: QuoteRequest, now = Date.now()): Promise<Quote> {
  const key = keyOf(request)
  const hit = cache.get(key)
  if (hit && now - hit.at < TTL_MS) return hit.quote
  const quote = requestQuote(request)
  cache.set(key, { at: now, quote })
  // A failed quote is not worth remembering.
  quote.catch(() => cache.delete(key))
  return quote
}

export function clearIndicativeQuotes(): void {
  cache.clear()
}
