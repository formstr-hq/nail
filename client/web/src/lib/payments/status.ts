export type OrderState = 'paid' | 'needs_attention' | 'expired' | 'timeout'

export interface PollOptions {
  intervalMs?: number
  /** Stop asking after this long: the webhook and the cron finish the job. */
  maxMs?: number
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Ask the backend until it says the order is settled. The browser may report
 * "done" before the webhook lands, so the client's own belief is never enough.
 * A failed request is just another "not yet": it is retried until the bound.
 */
export async function pollOrderStatus(
  fetchStatus: () => Promise<{ status: string }>,
  opts: PollOptions = {},
): Promise<OrderState> {
  const { intervalMs = 2000, maxMs = 120_000, signal, now = Date.now, sleep = defaultSleep } = opts
  const deadline = now() + maxMs
  for (;;) {
    if (signal?.aborted) return 'timeout'
    try {
      const { status } = await fetchStatus()
      if (status === 'paid') return 'paid'
      if (status === 'needs_attention') return 'needs_attention'
      if (status === 'expired') return 'expired'
    } catch {
      // transient: keep asking
    }
    if (now() + intervalMs > deadline) return 'timeout'
    await sleep(intervalMs)
  }
}
