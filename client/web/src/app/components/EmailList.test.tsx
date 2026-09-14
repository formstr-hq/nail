/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './test-utils'
import { EmailList } from './EmailList'
import { useMailStore } from '@/app/store/mail'
import { useAccountStore } from '@/app/store/account'
import type { Email } from '@/app/types/mail'
import type { InboxStatus } from '@/app/hooks/useInbox'


const FAKE_ACTIVE = { nip44Encrypt: async () => 'x' } as never

const LIVE: InboxStatus = { phase: 'live', relays: ['wss://r'], decoding: 0 }

function email(over: Partial<Email> = {}): Email {
  return {
    id: 'a'.repeat(64),
    from: { address: 'sender@example.com', name: 'Ada' },
    to: [{ address: 'me@mailstr.app' }],
    subject: 'Hello there',
    body: 'The body copy.',
    attachments: [],
    timestamp: 1_000_000,
    senderPubkey: 'c'.repeat(64),
    senderProof: 'nip05',
    read: false,
    labelEventIds: [],
    labels: [],
    ...over,
  }
}

beforeEach(() => {
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
  useAccountStore.setState({ account: null, active: null })
})

describe('EmailList happy path', () => {
  it('lists mail for the inbox folder, newest first, with unread count', () => {
    useMailStore.getState().addEmail(email({ id: 'a'.repeat(64), timestamp: 100, subject: 'Older' }))
    useMailStore.getState().addEmail(email({ id: 'b'.repeat(64), timestamp: 200, subject: 'Newer' }))
    useAccountStore.setState({
      account: { pubkey: 'd'.repeat(64) } as never,
      active: FAKE_ACTIVE,
    })

    render(<EmailList status={LIVE} onRetry={() => {}} />)

    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.className.includes('text-primary') === true && el.textContent === '2 unread')).toBeInTheDocument()
    // Newest first: the row buttons carry sender+subject; the header buttons
    // (refresh, search) come first, so match rows by their subject text.
    const rows = screen.getAllByRole('button').filter((b) => b.textContent?.includes('subject') || /Newer|Older/.test(b.textContent ?? ''))
    expect(rows[0].textContent).toContain('Newer')
    expect(rows[1].textContent).toContain('Older')
  })

  it('marks a mail read and selects it when clicked', async () => {
    const user = userEvent.setup()
    useMailStore.getState().addEmail(email())
    useAccountStore.setState({ account: { pubkey: 'd'.repeat(64) } as never, active: FAKE_ACTIVE })

    render(<EmailList status={LIVE} onRetry={() => {}} />)
    await user.click(screen.getByRole('button', { name: /Hello there/ }))

    const after = useMailStore.getState()
    expect(after.selectedId).toBe('a'.repeat(64))
    expect(after.mailState['a'.repeat(64)]?.read).toBe(true)
    // Unread counter disappears.
    expect(screen.queryByText(/unread/)).not.toBeInTheDocument()
  })

  it('search filters by subject and offers a clear action', async () => {
    const user = userEvent.setup()
    useMailStore.getState().addEmail(email({ subject: 'Invoice' }))
    useMailStore.getState().addEmail(email({ id: 'b'.repeat(64), subject: 'Lunch' }))
    useAccountStore.setState({ account: { pubkey: 'd'.repeat(64) } as never, active: FAKE_ACTIVE })

    render(<EmailList status={LIVE} onRetry={() => {}} />)
    await user.type(screen.getByLabelText('Search Inbox'), 'invoice')

    expect(screen.getByText('Invoice')).toBeInTheDocument()
    expect(screen.queryByText('Lunch')).not.toBeInTheDocument()

    // A query with no matches shows the empty state with a clear action.
    await user.type(screen.getByLabelText('Search Inbox'), 'zzz-no-match')
    await user.click(screen.getByRole('button', { name: /clear search/i }))
    expect(useMailStore.getState().query).toBe('')
  })

  it('shows the decrypting state with the pending count', () => {
    useAccountStore.setState({ account: { pubkey: 'd'.repeat(64) } as never, active: FAKE_ACTIVE })
    render(
      <EmailList status={{ phase: 'live', relays: ['wss://r'], decoding: 3 }} onRetry={() => {}} />,
    )
    expect(screen.getByText('Reading your mail')).toBeInTheDocument()
    expect(screen.getByText(/Decrypting 3 messages/)).toBeInTheDocument()
  })

  it('files trashed mail into Trash and offers empty-trash', () => {
    useMailStore.getState().addEmail(email())
    useMailStore.getState().setFlag('a'.repeat(64), { trashed: true })
    useAccountStore.setState({ account: { pubkey: 'd'.repeat(64) } as never, active: FAKE_ACTIVE })

    useMailStore.setState({ folder: 'trash' })
    render(<EmailList status={LIVE} onRetry={() => {}} />)

    expect(screen.getByText('Trash')).toBeInTheDocument()
    expect(screen.getByText(/Hello there/)).toBeInTheDocument()
  })
})