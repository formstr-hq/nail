/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import '@/app/components/test-utils'
import { useAliasInboxStats } from './useAliasInboxStats'
import { useAccountStore } from '@/app/store/account'
import { useMailStore } from '@/app/store/mail'
import { useSettingsStore } from '@/app/store/settings'
import type { Email } from '@/app/types/mail'

const ME = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const ALICE = 'alice@mailstr.app'
const BOB = 'bob@mailstr.app'

function mail(
  id: string,
  to: string,
  senderPubkey: string,
  timestamp: number,
  read = false,
): Email {
  return {
    id,
    fromHeader: { address: 'sender@example.com' },
    to: [{ address: to }],
    cc: [],
    subject: '',
    body: '',
    attachments: [],
    timestamp,
    senderPubkey,
    read,
    labelEventIds: [],
    labels: [],
  }
}

beforeEach(() => {
  useAccountStore.setState({
    account: { pubkey: ME } as never,
    active: null,
  })
  useSettingsStore.setState({ settings: {}, loaded: true, loading: false })
})

describe('useAliasInboxStats', () => {
  it('counts unread Inbox mail and tracks recent activity, excluding sent and spam', () => {
    const emails = {
      e1: mail('e1', ALICE, OTHER, 100),
      e2: mail('e2', BOB, ME, 200),
      e3: mail('e3', ALICE, OTHER, 300, true),
      e4: mail('e4', ALICE, OTHER, 400),
    }
    useMailStore.setState({
      emails,
      mailState: { e4: { folder: 'spam', updatedAt: 0 } },
      inboxFilter: null,
      folder: 'inbox',
    })

    const { result } = renderHook(() =>
      useAliasInboxStats([ALICE, BOB], new Map([['e2', { address: BOB }]])),
    )

    // e1 is the only unread Inbox message for Alice; e4 is Spam, e3 is read.
    // Her last activity still sees the newest spam message (e4).
    expect(result.current.get(ALICE)).toEqual({ unread: 1, lastAt: 400 })
    // Bob's message is our own Sent copy: activity yes, unread no.
    expect(result.current.get(BOB)).toEqual({ unread: 0, lastAt: 200 })
  })

  it('ignores aliases that are not in the watch list', () => {
    useMailStore.setState({
      emails: { e1: mail('e1', 'someone@else.test', OTHER, 100) },
      mailState: {},
      inboxFilter: null,
      folder: 'inbox',
    })

    const { result } = renderHook(() =>
      useAliasInboxStats([ALICE], new Map()),
    )

    expect(result.current.has(ALICE)).toBe(false)
  })
})
