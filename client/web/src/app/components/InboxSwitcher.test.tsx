/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './test-utils'
import { InboxSwitcher } from './InboxSwitcher'
import type { AliasInboxStats } from '@/app/lib/mail/inboxAddresses'

const ALIASES = [
  'alice@mailstr.app',
  'bob@mailstr.app',
  'carol@mailstr.app',
  'dave@mailstr.app',
  'amy@acme.com',
  'ben@acme.com',
  'cat@acme.com',
]

const STATS = new Map<string, AliasInboxStats>([
  ['alice@mailstr.app', { unread: 1, lastAt: 50 }],
  ['bob@mailstr.app', { unread: 2, lastAt: 40 }],
  ['carol@mailstr.app', { unread: 0, lastAt: 30 }],
  ['dave@mailstr.app', { unread: 0, lastAt: 0 }],
  ['amy@acme.com', { unread: 0, lastAt: 20 }],
  ['ben@acme.com', { unread: 0, lastAt: 0 }],
  ['cat@acme.com', { unread: 0, lastAt: 0 }],
])

function setup(overrides: Partial<React.ComponentProps<typeof InboxSwitcher>> = {}) {
  const onSelect = vi.fn()
  const onTogglePin = vi.fn().mockResolvedValue(undefined)
  render(
    <InboxSwitcher
      aliases={ALIASES}
      current="bob@mailstr.app"
      pinned={['alice@mailstr.app']}
      stats={STATS}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      {...overrides}
    />,
  )
  return { onSelect, onTogglePin }
}

async function openPicker() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /all addresses/i }))
  await screen.findByRole('heading', { name: /choose an address/i })
  return user
}

describe('InboxSwitcher', () => {
  it('opens the full list grouped by domain with pinned and recently active sections', async () => {
    setup()
    await openPicker()

    expect(screen.getByText('Pinned')).toBeInTheDocument()
    expect(screen.getByText('mailstr.app')).toBeInTheDocument()
    expect(screen.getByText('acme.com')).toBeInTheDocument()
    // Alice is pinned; Bob is current and therefore excluded from Recent.
    const recent = within(screen.getByRole('region', { name: 'Recently active' }))
    expect(recent.getByText('carol@mailstr.app')).toBeInTheDocument()
    expect(recent.getByText('amy@acme.com')).toBeInTheDocument()
    expect(recent.queryByText('bob@mailstr.app')).not.toBeInTheDocument()
  })

  it('searches every address, including pinned ones', async () => {
    setup()
    const user = await openPicker()
    const search = screen.getByRole('searchbox', { name: /search addresses/i })

    await user.type(search, 'acme')

    expect(screen.queryByText('alice@mailstr.app')).not.toBeInTheDocument()
    expect(screen.getByText('amy@acme.com')).toBeInTheDocument()
    expect(screen.getByText('ben@acme.com')).toBeInTheDocument()
    expect(screen.getByText('cat@acme.com')).toBeInTheDocument()

    // Pinned addresses are still findable from the full-text search.
    await user.clear(search)
    await user.type(search, 'alice')
    expect(screen.getByText('alice@mailstr.app')).toBeInTheDocument()
  })

  it('pins an address and selects it', async () => {
    const { onSelect, onTogglePin } = setup()
    const user = await openPicker()

    // Amy appears in both "Recently active" and her domain group.
    await user.click(
      screen.getAllByRole('button', { name: /pin amy@acme.com/i })[0],
    )
    expect(onTogglePin).toHaveBeenCalledWith('amy@acme.com')

    await user.click(screen.getAllByTitle('amy@acme.com')[0])
    expect(onSelect).toHaveBeenCalledWith('amy@acme.com')
    expect(
      screen.queryByRole('heading', { name: /choose an address/i }),
    ).not.toBeInTheDocument()
  })

  it('disables unpinned stars once the pin limit is reached', async () => {
    setup({
      pinned: [
        'alice@mailstr.app',
        'bob@mailstr.app',
        'carol@mailstr.app',
        'dave@mailstr.app',
        'amy@acme.com',
      ],
      current: null,
    })
    await openPicker()

    expect(
      screen.getByRole('button', { name: /pin ben@acme.com/i }),
    ).toBeDisabled()
  })
})
