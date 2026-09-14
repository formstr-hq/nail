/**
 * Watches for a local-relay boot failure after the fact.
 *
 * A dead relay worker fails SILENTLY otherwise: `observe()` returns a handle
 * either way, no events ever flow, and the user sees an eternally empty
 * "connecting" inbox. Some failures are known at spawn time, but a worker can
 * also die later (an `onerror` after construction, a rejected `service.start()`
 * reported over the channel) — so the caller polls a boot-error accessor.
 *
 * Extracted from the useInbox effect (audit C2: schedulers/watchdogs belong in
 * plain testable modules) so the interval lifecycle is unit-testable and the
 * hook only wires the callback.
 */
export class RelayBootWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly readError: () => string | null
  private readonly onError: (message: string) => void
  private readonly intervalMs: number

  constructor(
    readError: () => string | null,
    onError: (message: string) => void,
    intervalMs = 1000,
  ) {
    this.readError = readError
    this.onError = onError
    this.intervalMs = intervalMs
  }

  /** Begin polling. Idempotent. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const bootError = this.readError()
      if (!bootError) return
      this.stop()
      this.onError(
        'The mail engine could not start in this browser ' +
          `(${bootError}). On an older iPhone or iPad, updating iOS may fix this.`,
      )
    }, this.intervalMs)
  }

  /** Stop polling. */
  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}
