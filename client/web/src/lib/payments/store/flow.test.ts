import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api', () => ({ verifyPurchase: vi.fn() }))
vi.mock('./iap', () => ({ buy: vi.fn(), drainPending: vi.fn(), restore: vi.fn() }))

import { verifyPurchase } from './api'
import { buy, drainPending, restore } from './iap'
import { completePurchase, purchase, restorePurchases, sweepPending } from './flow'
import { recallIntent } from './intents'

const signer = {} as never
const verify = vi.mocked(verifyPurchase)

function pending(productId: string, over: Record<string, unknown> = {}) {
  const finish = vi.fn(async () => {})
  return {
    platform: 'google' as const,
    productId,
    receipt: { purchaseToken: `tok-${productId}` },
    finish,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

describe('completePurchase', () => {
  it('finishes the purchase only after the backend recorded it', async () => {
    verify.mockResolvedValue({ status: 'provisioned', seats: 10 })
    const p = pending('workspace_seats_10')
    expect(await completePurchase(signer, p, { domain: 'acme.com' })).toEqual({ status: 'paid' })
    expect(verify).toHaveBeenCalledWith(signer, {
      platform: 'google',
      productId: 'workspace_seats_10',
      receipt: { purchaseToken: 'tok-workspace_seats_10' },
      domain: 'acme.com',
    })
    expect(p.finish).toHaveBeenCalledTimes(1)
  })

  it('treats a replay as success and still finishes', async () => {
    verify.mockResolvedValue({ status: 'already_provisioned' })
    const p = pending('mailbox_base')
    expect((await completePurchase(signer, p, { nip05: 'alice' })).status).toBe('paid')
    expect(p.finish).toHaveBeenCalled()
  })

  it('does not finish a purchase the backend could not provision', async () => {
    verify.mockResolvedValue({ status: 'needs_attention', reason: 'taken' })
    const p = pending('mailbox_base')
    expect(await completePurchase(signer, p, { nip05: 'alice' })).toEqual({
      status: 'needs_attention',
      reason: 'taken',
    })
    expect(p.finish).not.toHaveBeenCalled()
  })

  it('does not finish when verification fails, so it is retried', async () => {
    verify.mockRejectedValue(new Error('network'))
    const p = pending('mailbox_base')
    await expect(completePurchase(signer, p, {})).rejects.toThrow('network')
    expect(p.finish).not.toHaveBeenCalled()
  })
})

describe('purchase', () => {
  it('returns cancelled when the buyer closes the store sheet, and forgets the intent', async () => {
    vi.mocked(buy).mockResolvedValue(null)
    expect(await purchase(signer, 'mailbox_base', { nip05: 'alice' })).toEqual({ status: 'cancelled' })
    expect(verify).not.toHaveBeenCalled()
    expect(recallIntent('mailbox_base')).toBeUndefined()
  })

  it('remembers the intent until the purchase is confirmed', async () => {
    const p = pending('workspace_seats_1')
    vi.mocked(buy).mockResolvedValue(p)
    verify.mockRejectedValue(new Error('network'))
    await expect(purchase(signer, 'workspace_seats_1', { domain: 'acme.com' })).rejects.toThrow()
    expect(recallIntent('workspace_seats_1')).toEqual({ domain: 'acme.com' })

    verify.mockResolvedValue({ status: 'provisioned', seats: 1 })
    await completePurchase(signer, p)
    expect(recallIntent('workspace_seats_1')).toBeUndefined()
  })
})

describe('sweepPending', () => {
  it('re-verifies leftovers with the remembered intent and survives one failure', async () => {
    const a = pending('workspace_seats_10')
    const b = pending('workspace_seats_50')
    vi.mocked(drainPending).mockReturnValue([a, b])
    localStorage.setItem('mailstr.pay.intents', JSON.stringify({ workspace_seats_10: { domain: 'acme.com' } }))
    verify.mockResolvedValueOnce({ status: 'already_provisioned' }).mockRejectedValueOnce(new Error('x'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = await sweepPending(signer)
    expect(out).toEqual([{ status: 'paid' }])
    expect(verify.mock.calls[0][1]).toMatchObject({ productId: 'workspace_seats_10', domain: 'acme.com' })
    expect(a.finish).toHaveBeenCalled()
    expect(b.finish).not.toHaveBeenCalled()
  })
})

describe('restorePurchases', () => {
  it('reports whether anything was restored', async () => {
    vi.mocked(restore).mockResolvedValue([pending('mailbox_base')])
    verify.mockResolvedValue({ status: 'already_provisioned' })
    expect(await restorePurchases(signer, { nip05: 'alice' })).toBe(true)
    vi.mocked(restore).mockResolvedValue([])
    expect(await restorePurchases(signer, { nip05: 'alice' })).toBe(false)
  })
})
