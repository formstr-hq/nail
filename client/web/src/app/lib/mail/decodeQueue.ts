/** The outcome of one queue item: a value, or a classified failure. */
export type QueueOutcome<T> =
  | { value: T; secret?: string }
  | { failure: { routine: boolean; reason: string; retryable?: boolean } }

export interface BoundedQueueCallbacks<T> {
  /** A successful decode. `secret` is whatever per-item credential the decode
   *  surfaced (for mail: the wrap author's key that powers delete-forever). */
  onResult: (value: T, secret: string | undefined) => void
  /** A non-routine failure (addressed to us but undecodable). Routine failures
   *  — other people's ciphertext we cannot read — are not reported. */
  onFailure: (event: import('nostr-tools').Event, reason: string) => void
  /** The backlog count changed (queued + in flight + awaiting retry). */
  onPendingChange: (pending: number) => void
}

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1500

interface QueueItem<T> {
  event: import('nostr-tools').Event
  decode: (event: import('nostr-tools').Event) => Promise<QueueOutcome<T>>
  attempt: number
}

/**
 * Bounded pump for signer-costly decoding work — gift-wrap decryption
 * (`DecodeQueue`'s original use) and kind-34578 metadata decoding alike.
 *
 * Decrypting costs one signer call, and with a NIP-46 bunker that is a full
 * relay round-trip. A subscription with no `since` replays every event the
 * relays hold and would fire all of those at the signer simultaneously —
 * enough to swamp a bunker and leave the inbox silently empty. This queue runs
 * at most `maxConcurrent` decodes at a time and reports its backlog so the UI
 * can render "still reading N messages" honestly.
 *
 * A `retryable` failure (signer timeout / unreachable bunker) is re-queued up
 * to MAX_RETRIES after a short delay instead of being dropped: the item is
 * ours, only the signer was busy. The final attempt is reported through
 * `onFailure`, so a permanently-dead signer surfaces rather than silently
 * losing mail.
 *
 * Extracted from the useInbox effect (audit C1/C2) so the pump is unit-testable
 * and hooks only wire callbacks; generic over the decoded value so useMailMeta
 * shares it instead of hand-rolling a second pump (E-3).
 */
export class BoundedDecodeQueue<T> {
  private readonly maxConcurrent: number
  private readonly callbacks: BoundedQueueCallbacks<T>
  private readonly queue: QueueItem<T>[] = []
  private running = 0
  private stopped = false
  /** Retry-delay timers, so stop() can cancel a pending re-queue. */
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(maxConcurrent: number, callbacks: BoundedQueueCallbacks<T>) {
    this.maxConcurrent = maxConcurrent
    this.callbacks = callbacks
  }

  /** How many items are queued, in flight, or awaiting a retry delay. */
  get pending(): number {
    return this.queue.length + this.running + this.retryTimers.size
  }

  /** Enqueue an item and start pumping. */
  push(
    event: import('nostr-tools').Event,
    decode: (event: import('nostr-tools').Event) => Promise<QueueOutcome<T>>,
  ): void {
    if (this.stopped) return
    this.queue.push({ event, decode, attempt: 0 })
    this.pump()
  }

  /** Stop accepting work and stop reporting. In-flight decodes finish; their
   *  results are dropped (the caller's own lifecycle flag owns the render gate). */
  stop(): void {
    this.stopped = true
    this.queue.length = 0
    for (const t of this.retryTimers) clearTimeout(t)
    this.retryTimers.clear()
  }

  private pump(): void {
    while (!this.stopped && this.running < this.maxConcurrent && this.queue.length) {
      const item = this.queue.shift()!
      this.running += 1
      void item
        .decode(item.event)
        .then((outcome) => {
          if (this.stopped) return
          if ('value' in outcome) {
            this.callbacks.onResult(outcome.value, outcome.secret)
            return
          }
          if (outcome.failure.retryable && item.attempt < MAX_RETRIES) {
            // Re-queue after a beat so a swamped bunker has time to recover.
            // pending counts the timer, so the UI keeps showing the work as
            // outstanding while we wait.
            const timer = setTimeout(() => {
              this.retryTimers.delete(timer)
              if (this.stopped) return
              item.attempt += 1
              this.queue.push(item)
              this.pump()
            }, RETRY_DELAY_MS)
            this.retryTimers.add(timer)
            return
          }
          // Routine: relays hand us everything tagged to us, and most of it is
          // not ours to read. Only the rest is a signal.
          if (outcome.failure.routine) return
          this.callbacks.onFailure(item.event, outcome.failure.reason)
        })
        .finally(() => {
          this.running -= 1
          this.pump()
          this.callbacks.onPendingChange(this.pending)
        })
    }
    this.callbacks.onPendingChange(this.pending)
  }
}

/** Mail-specific outcome — the shape receive.ts hands back. */
export type DecodeOutcome =
  | { email: import('@/app/types/mail').Email; wrapSecret?: string }
  | { failure: { routine: boolean; reason: string; retryable?: boolean } }

export interface DecodeQueueCallbacks {
  /** A wrap decoded into an email. Save the wrap key BEFORE the email:
   *  delete-forever needs it on hand, and a crash between the two must not
   *  strand the mail as undeletable. */
  onEmail: (email: import('@/app/types/mail').Email, wrapSecret: string | undefined) => void
  /** A non-routine failure (a wrap addressed to us that we could not decode).
   *  Routine failures — other people's mail we cannot read — are not reported. */
  onFailure: (event: import('nostr-tools').Event, reason: string) => void
  /** The backlog count changed (queued + in-flight + retrying). */
  onPendingChange: (pending: number) => void
}

/**
 * The inbox's gift-wrap decode queue. Mail-typed wrapper over
 * BoundedDecodeQueue so the inbox call site and its tests keep the original
 * `{ email } | { failure }` outcome shape.
 */
export class DecodeQueue {
  private readonly inner: BoundedDecodeQueue<import('@/app/types/mail').Email>

  constructor(maxConcurrent: number, callbacks: DecodeQueueCallbacks) {
    this.inner = new BoundedDecodeQueue(maxConcurrent, {
      onResult: callbacks.onEmail,
      onFailure: callbacks.onFailure,
      onPendingChange: callbacks.onPendingChange,
    })
  }

  get pending(): number {
    return this.inner.pending
  }

  push(
    event: import('nostr-tools').Event,
    decode: (event: import('nostr-tools').Event) => Promise<DecodeOutcome>,
  ): void {
    this.inner.push(event, async (e) => {
      const outcome = await decode(e)
      if ('email' in outcome) {
        return { value: outcome.email, secret: outcome.wrapSecret }
      }
      return { failure: outcome.failure }
    })
  }

  stop(): void {
    this.inner.stop()
  }
}
