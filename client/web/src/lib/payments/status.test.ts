import { describe, it, expect, vi } from 'vitest'
import { pollOrderStatus } from './status'
import { checkoutUiMode, pickDefaultMethod } from './channels'

function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
}

describe('pollOrderStatus', () => {
  it('resolves as soon as the backend says paid', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'paid' })
    expect(await pollOrderStatus(fetchStatus, clock())).toBe('paid')
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('reports needs_attention and expired as terminal', async () => {
    expect(await pollOrderStatus(async () => ({ status: 'needs_attention' }), clock())).toBe('needs_attention')
    expect(await pollOrderStatus(async () => ({ status: 'expired' }), clock())).toBe('expired')
  })

  it('keeps asking through transient errors, then gives up at the bound', async () => {
    const fetchStatus = vi.fn().mockRejectedValue(new Error('network'))
    const c = clock()
    expect(await pollOrderStatus(fetchStatus, { ...c, intervalMs: 2000, maxMs: 10_000 })).toBe('timeout')
    expect(fetchStatus.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(fetchStatus.mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('stops when aborted', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const fetchStatus = vi.fn()
    expect(await pollOrderStatus(fetchStatus, { ...clock(), signal: ctl.signal })).toBe('timeout')
    expect(fetchStatus).not.toHaveBeenCalled()
  })
})

describe('pickDefaultMethod', () => {
  it('uses the remembered method only while it is offered', () => {
    expect(pickDefaultMethod(['a', 'b'], 'b')).toBe('b')
    expect(pickDefaultMethod(['a', 'b'], 'c')).toBe('a')
    expect(pickDefaultMethod(['a', 'b'], null)).toBe('a')
    expect(pickDefaultMethod([], 'a')).toBeNull()
  })
})

describe('checkoutUiMode', () => {
  it('embeds in the browser and goes hosted in the native shell', () => {
    expect(checkoutUiMode(false)).toBe('embedded')
    expect(checkoutUiMode(true)).toBe('hosted')
  })
})
