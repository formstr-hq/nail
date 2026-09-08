import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Persistence contract tests for the mail store.
 *
 * The store persists through zustand/persist but MUST keep the same localStorage
 * keys and bare-value shapes the pre-persist build wrote by hand:
 *  - mailstr.mailstate.v1  (Record<string, MailFlags>)
 *  - mailstr.wrapkeys.v1   (Record<string, string>)
 *  - mailstr.deleted.v1    (string[])
 * and must fold the legacy `mailstr.read` id-set into mailState without
 * deleting it (a rollback build must still find it there — AGENTS rule 8).
 *
 * These tests drive a real storage shim so every write/read is verbatim.
 */

// Minimal localStorage shim over an in-memory map.
function makeLocalStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => void map.clear(),
    _map: map,
  }
}

type StoreMod = typeof import('./mail')

let store: StoreMod

beforeEach(async () => {
  vi.resetModules()
  const shim = makeLocalStorage()
  vi.stubGlobal('localStorage', shim)
  // Fresh module import so the persist middleware hydrates from the shim.
  store = await import('./mail')
})

const ID = 'a'.repeat(64)
const ID2 = 'b'.repeat(64)

describe('mail store persistence', () => {
  it('writes the same keys and bare shapes the pre-persist build used', async () => {
    const s = store.useMailStore.getState()
    s.saveWrapKey(ID, 'f'.repeat(64))
    s.setFlag(ID, { read: true })
    s.markDeleted(ID2)

    const ls = localStorage as unknown as ReturnType<typeof makeLocalStorage> & { _map: Map<string, string> }
    const wrapKeys = JSON.parse(ls._map.get('mailstr.wrapkeys.v1')!)
    const mailState = JSON.parse(ls._map.get('mailstr.mailstate.v1')!)
    const deleted = JSON.parse(ls._map.get('mailstr.deleted.v1')!)

    expect(wrapKeys[ID]).toBe('f'.repeat(64))
    expect(mailState[ID]).toMatchObject({ read: true })
    expect(mailState[ID2].deleted).toBe(true)
    expect(deleted).toEqual([ID2])
  })

  it('hydrates from pre-existing hand-rolled storage (upgrade path)', async () => {
    const ls = localStorage as unknown as { setItem: (k: string, v: string) => void }
    ls.setItem('mailstr.mailstate.v1', JSON.stringify({ [ID]: { read: true, updatedAt: 100 } }))
    ls.setItem('mailstr.wrapkeys.v1', JSON.stringify({ [ID]: 'key' }))
    ls.setItem('mailstr.deleted.v1', JSON.stringify([ID2]))

    const fresh: StoreMod = await import('./mail?upgrade' as string)
    const st = fresh.useMailStore.getState()
    expect(st.mailState[ID]).toEqual({ read: true, updatedAt: 100 })
    expect(st.wrapKeys[ID]).toBe('key')
    expect(st.deletedIds.has(ID2)).toBe(true)
  })

  it('folds the legacy mailstr.read set into mailState without deleting the key', async () => {
    const ls = localStorage as unknown as { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void }
    ls.setItem('mailstr.read', JSON.stringify([ID]))

    const fresh: StoreMod = await import('./mail?legacy' as string)
    const st = fresh.useMailStore.getState()
    expect(st.mailState[ID]).toEqual({ read: true, updatedAt: 0 })
    // The legacy key must survive — a rollback build reads it back.
    expect(localStorage.getItem('mailstr.read')).not.toBeNull()
  })

  it('does not resurrect deleted mail on rehydrate', async () => {
    const ls = localStorage as unknown as { setItem: (k: string, v: string) => void }
    ls.setItem('mailstr.deleted.v1', JSON.stringify([ID]))
    ls.setItem('mailstr.mailstate.v1', JSON.stringify({ [ID]: { deleted: true, updatedAt: 5 } }))

    const fresh: StoreMod = await import('./mail?tombstone' as string)
    const st = fresh.useMailStore.getState()
    expect(st.deletedIds.has(ID)).toBe(true)
    expect(st.mailState[ID]?.deleted).toBe(true)
    // addEmail (a relay replay) must refuse it.
    st.addEmail({
      id: ID,
      from: { address: 'x@y.com' },
      to: [{ address: 'me@mailstr.app' }],
      subject: '',
      body: '',
      attachments: [],
      timestamp: 1,
      senderPubkey: 'c'.repeat(64),
      senderProof: 'nip05',
      read: false,
      labelEventIds: [],
      labels: [],
    })
    expect(fresh.useMailStore.getState().emails[ID]).toBeUndefined()
  })
})