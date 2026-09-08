import type { Event } from 'nostr-tools'

/** The outcome of decoding one gift wrap — what receive.ts hands back. */
export type DecodeOutcome =
  | { email: import('@/app/types/mail').Email; wrapSecret?: string }
  | { failure: { routine: boolean; reason: string } }

export interface DecodeQueueCallbacks {
  /** A wrap decoded into an email. Save the wrap key BEFORE the email:
   *  delete-forever needs it on hand, and a crash between the two must not
   *  strand the mail as undeletable. */
  onEmail: (email: import('@/app/types/mail').Email, wrapSecret: string | undefined) => void
  /** A non-routine failure (a wrap addressed to us that we could not decode).
   *  Routine failures — other people's mail we cannot read — are not reported. */
  onFailure: (event: Event, reason: string) => void
  /** The backlog count changed (queued + in-flight). Reaches 0 when done. */
  onPendingChange: (pending: number) => void
}

/**
 * Bounded pump for gift-wrap decryption.
 *
 * Decrypting a gift wrap costs one signer call, and with a NIP-46 bunker that
 * is a full relay round-trip. A subscription with no `since` replays every wrap
 * the relays hold on reload and would fire all of those at the signer
 * simultaneously — enough to swamp a bunker and leave the inbox silently
 * empty. This queue runs at most `maxConcurrent` decodes at a time and reports
 * its backlog so the UI can render "still reading N messages" honestly.
 *
 * Extracted from the useInbox effect (audit C1) so the pump is unit-testable
 * and the hook only wires callbacks.
 */
export class DecodeQueue {
  private readonly maxConcurrent: number
  private readonly callbacks: DecodeQueueCallbacks
  private readonly queue: Array<{ event: Event; decode: (event: Event) => Promise<DecodeOutcome> }> = []
  private running = 0
  private stopped = false

  constructor(maxConcurrent: number, callbacks: DecodeQueueCallbacks) {
    this.maxConcurrent = maxConcurrent
    this.callbacks = callbacks
  }

  /** How many wraps are queued or in flight. */
  get pending(): number {
    return this.queue.length + this.running
  }

  /** Enqueue a wrap and start pumping. */
  push(event: Event, decode: (event: Event) => Promise<DecodeOutcome>): void {
    if (this.stopped) return
    this.queue.push({ event, decode })
    this.pump()
  }

  /** Stop accepting work and stop reporting. In-flight decodes finish; their
   *  results are dropped (the hook's `alive` flag owns the render gate). */
  stop(): void {
    this.stopped = true
    this.queue.length = 0
  }

  private pump(): void {
    while (!this.stopped && this.running < this.maxConcurrent && this.queue.length) {
      const { event, decode } = this.queue.shift()!
      this.running += 1
      void decode(event)
        .then((outcome) => {
          if (this.stopped) return
          if ('email' in outcome) {
            this.callbacks.onEmail(outcome.email, outcome.wrapSecret)
            return
          }
          // Routine: relays hand us every wrap p-tagged to us, and most are
          // other people's mail we cannot read. Only the rest is a signal.
          if (outcome.failure.routine) return
          this.callbacks.onFailure(event, outcome.failure.reason)
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