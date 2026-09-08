import { describe, expect, it, vi } from 'vitest'
import type { Event } from 'nostr-tools'
import { DecodeQueue, type DecodeOutcome } from './decodeQueue'

const wrapEvent = (id: string): Event => ({ id, kind: 1059 } as unknown as Event)

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const noopDecode = () => Promise.resolve({ failure: { routine: true, reason: 'other mail' } })

describe('DecodeQueue', () => {
  it('runs at most maxConcurrent decodes at a time', async () => {
    let inFlight = 0
    let maxSeen = 0
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()]
    const decode = (i: number) => async (): Promise<DecodeOutcome> => {
      inFlight += 1
      maxSeen = Math.max(maxSeen, inFlight)
      await gates[i].promise
      inFlight -= 1
      return { failure: { routine: true, reason: 'x' } }
    }

    const q = new DecodeQueue(3, { onEmail: vi.fn(), onFailure: vi.fn(), onPendingChange: vi.fn() })
    for (let i = 0; i < 5; i++) q.push(wrapEvent(`e${i}`), decode(i))
    expect(maxSeen).toBe(3)
    expect(q.pending).toBe(5)

    // Resolving two in-flight gates lets exactly two queued items start; the
    // running count must never climb back above the bound.
    gates[0].resolve()
    gates[1].resolve()
    await vi.waitFor(() => expect(inFlight).toBe(3))
    expect(maxSeen).toBe(3)
    gates[2].resolve()
    gates[3].resolve()
    gates[4].resolve()
    await vi.waitFor(() => expect(q.pending).toBe(0))
    expect(maxSeen).toBe(3)
  })

  it('reports pending counts that reach zero when the backlog is done', async () => {
    const pending: number[] = []
    const q = new DecodeQueue(2, { onEmail: vi.fn(), onFailure: vi.fn(), onPendingChange: (n) => pending.push(n) })
    q.push(wrapEvent('a'), noopDecode)
    q.push(wrapEvent('b'), noopDecode)
    expect(q.pending).toBe(2)
    await vi.waitFor(() => expect(pending[pending.length - 1]).toBe(0))
    expect(q.pending).toBe(0)
  })

  it('delivers emails with the wrap secret through onEmail', async () => {
    const onEmail = vi.fn()
    const q = new DecodeQueue(1, { onEmail, onFailure: vi.fn(), onPendingChange: vi.fn() })
    q.push(
      wrapEvent('a'),
      () => Promise.resolve({ email: { id: 'm1' } as never, wrapSecret: 'secret' }),
    )
    await vi.waitFor(() => expect(onEmail).toHaveBeenCalledWith({ id: 'm1' }, 'secret'))
  })

  it('reports only non-routine failures', async () => {
    const onFailure = vi.fn()
    const q = new DecodeQueue(1, { onEmail: vi.fn(), onFailure, onPendingChange: vi.fn() })
    q.push(wrapEvent('r'), () => Promise.resolve({ failure: { routine: true, reason: 'other mail' } }))
    q.push(wrapEvent('n'), () => Promise.resolve({ failure: { routine: false, reason: 'bad seal' } }))
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1))
    expect(onFailure).toHaveBeenCalledWith(wrapEvent('n'), 'bad seal')
  })

  it('stop() drops queued work and stops delivering results', async () => {
    const onEmail = vi.fn()
    const gate = deferred<DecodeOutcome>()
    const q = new DecodeQueue(1, { onEmail, onFailure: vi.fn(), onPendingChange: vi.fn() })
    q.push(wrapEvent('a'), () => gate.promise)
    q.push(wrapEvent('b'), noopDecode)
    q.stop()
    expect(q.pending).toBe(1) // the in-flight one; the queued one is dropped
    gate.resolve({ email: { id: 'm1' } as never })
    await vi.waitFor(() => expect(q.pending).toBe(0))
    expect(onEmail).not.toHaveBeenCalled()
  })

  it('push() after stop() is a no-op', () => {
    const q = new DecodeQueue(1, { onEmail: vi.fn(), onFailure: vi.fn(), onPendingChange: vi.fn() })
    q.stop()
    q.push(wrapEvent('a'), noopDecode)
    expect(q.pending).toBe(0)
  })
})