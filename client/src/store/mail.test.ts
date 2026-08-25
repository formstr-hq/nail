import { describe, it, expect, beforeEach } from 'vitest'
import { useMailStore } from './mail'
import type { Email } from '@/types/mail'

// Node env has no localStorage: the store's load/persist helpers catch the
// failure and run in-memory, which is exactly what these tests exercise.

const ID = 'a'.repeat(64)

function email(id = ID): Email {
  return {
    id,
    from: { address: 'sender@example.com' },
    to: [{ address: 'me@mailstr.app' }],
    subject: 'hello',
    body: 'body',
    attachments: [],
    timestamp: 1_000_000,
    senderPubkey: 'c'.repeat(64),
    senderProof: 'nip05',
    read: false,
    labelEventIds: [],
    labels: [],
  }
}

beforeEach(() => {
  // Reset to a pristine mailbox; the persisted-key loaders returned empty
  // anyway, so plain initial state suffices.
  useMailStore.setState({
    emails: {},
    seenIds: new Set(),
    mailState: {},
    wrapKeys: {},
    deletedIds: new Set(),
    selectedId: null,
    folder: 'inbox',
    query: '',
    inboxFilter: null,
  })
})

describe('delete forever, locally', () => {
  it('markDeleted purges the mail, drops its wrap key, and returns deleted flags for publishing', () => {
    const s = useMailStore.getState()
    s.addEmail(email())
    s.saveWrapKey(ID, 'f'.repeat(64))
    s.setFlag(ID, { trashed: true })

    const merged = useMailStore.getState().markDeleted(ID)

    expect(merged.deleted).toBe(true)
    expect(merged.trashed).toBe(true) // prior flags preserved in the meta write
    const after = useMailStore.getState()
    expect(after.emails[ID]).toBeUndefined()
    expect(after.wrapKeys[ID]).toBeUndefined()
    expect(after.deletedIds.has(ID)).toBe(true)
    expect(after.mailState[ID]?.deleted).toBe(true)
  })

  it('markDeleted closes the reading pane when the open mail is purged', () => {
    const s = useMailStore.getState()
    s.addEmail(email())
    s.setSelected(ID)
    s.markDeleted(ID)
    expect(useMailStore.getState().selectedId).toBeNull()
  })

  it('addEmail refuses to resurrect a tombstoned wrap — the replay guard', () => {
    const s = useMailStore.getState()
    s.addEmail(email())
    s.markDeleted(ID)

    // A relay that ignored the kind-5 serves the wrap again; the store must
    // not let it back into the view.
    useMailStore.getState().addEmail(email())
    expect(useMailStore.getState().emails[ID]).toBeUndefined()

    expect(useMailStore.getState().seenIds.has(ID)).toBe(true) // no re-decode cost either
  })

  it('a mail whose synced flags say deleted (from another device) is also refused', () => {
    useMailStore.setState({
      mailState: { [ID]: { deleted: true, updatedAt: 2_000_000 } },
    })
    useMailStore.getState().addEmail(email())
    expect(useMailStore.getState().emails[ID]).toBeUndefined()
  })

  it('hydrateFlags applies a cross-device delete: purge + tombstone', () => {
    const s = useMailStore.getState()
    s.addEmail(email())
    s.saveWrapKey(ID, 'f'.repeat(64))
    s.setSelected(ID)

    useMailStore
      .getState()
      .hydrateFlags([{ ref: ID, flags: { deleted: true, updatedAt: 2_000_000 } }])

    const after = useMailStore.getState()
    expect(after.emails[ID]).toBeUndefined()
    expect(after.deletedIds.has(ID)).toBe(true)
    expect(after.wrapKeys[ID]).toBeUndefined()
    expect(after.selectedId).toBeNull()
  })

  it('a stale meta event must not resurrect a locally deleted mail', () => {
    const s = useMailStore.getState()
    s.addEmail(email())
    s.markDeleted(ID)

    // Relay replays an OLD pre-delete version of the state — newest-wins by
    // updatedAt is what stops it.
    useMailStore
      .getState()
      .hydrateFlags([{ ref: ID, flags: { read: true, updatedAt: 1 } }])

    const after = useMailStore.getState()
    expect(after.mailState[ID]?.deleted).toBe(true)
    expect(after.deletedIds.has(ID)).toBe(true)
  })

  it('saveWrapKey remembers the wrap author key for a later delete', () => {
    useMailStore.getState().saveWrapKey(ID, 'f'.repeat(64))
    expect(useMailStore.getState().wrapKeys[ID]).toBe('f'.repeat(64))
  })
})
