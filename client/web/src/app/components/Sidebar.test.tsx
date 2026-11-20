/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import './test-utils'
import { Sidebar } from './Sidebar'
import { useAccountStore } from '@/app/store/account'
import { useMailStore } from '@/app/store/mail'
import { useSettingsStore } from '@/app/store/settings'

vi.mock('./AccountSwitcher', () => ({ AccountSwitcher: () => null }))
vi.mock('./ui/ThemeToggle', () => ({ ThemeToggle: () => null }))
vi.mock('@/app/hooks/useAliasInboxStats', () => ({
  useAliasInboxStats: () => new Map(),
}))

const ALIASES = [
  'alice@mailstr.app',
  'bob@mailstr.app',
  'carol@mailstr.app',
  'dave@mailstr.app',
  'erin@mailstr.app',
  'amy@acme.com',
  'ben@acme.com',
]

const STATUS = {
  phase: 'live' as const,
  relays: ['wss://relay.example'],
  decoding: 0,
}

function renderSidebar(aliases = ALIASES) {
  render(
    <Sidebar
      onCompose={vi.fn()}
      onSettings={vi.fn()}
      onOpenRelays={vi.fn()}
      onAddAccount={vi.fn()}
      onBuyAddress={vi.fn()}
      aliases={aliases}
      status={STATUS}
    />,
  )
}

describe('Sidebar inbox list', () => {
  it('keeps a large address list bounded to pinned/current plus the picker', () => {
    useAccountStore.setState({
      account: { pubkey: 'a'.repeat(64) } as never,
      active: { signEvent: vi.fn() } as never,
    })
    useMailStore.setState({
      emails: {},
      mailState: {},
      inboxFilter: null,
      folder: 'inbox',
    })
    useSettingsStore.setState({
      settings: { pinnedInboxes: ['alice@mailstr.app'] },
      loaded: true,
      loading: false,
    })

    renderSidebar()

    // The pinned address and the picker stay in the sidebar.
    expect(screen.getByText('alice@mailstr.app')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /all addresses/i }),
    ).toBeInTheDocument()
    // The long tail is not rendered as nav rows.
    expect(screen.queryByText('dave@mailstr.app')).not.toBeInTheDocument()
    expect(screen.queryByText('ben@acme.com')).not.toBeInTheDocument()
    // Folders remain visible alongside the compact inbox section.
    expect(screen.getByText('Folders')).toBeInTheDocument()
    expect(screen.getByText('Buy a new address')).toBeInTheDocument()
  })

  it('keeps an unpinned current address visible', () => {
    useAccountStore.setState({
      account: { pubkey: 'a'.repeat(64) } as never,
      active: { signEvent: vi.fn() } as never,
    })
    useMailStore.setState({
      emails: {},
      mailState: {},
      inboxFilter: 'bob@mailstr.app',
      folder: 'inbox',
    })
    useSettingsStore.setState({
      settings: {},
      loaded: true,
      loading: false,
    })

    renderSidebar()

    expect(screen.getByText('bob@mailstr.app')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /all addresses/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText('dave@mailstr.app')).not.toBeInTheDocument()
  })

  it('keeps the familiar flat list for small accounts', () => {
    useAccountStore.setState({
      account: { pubkey: 'a'.repeat(64) } as never,
      active: { signEvent: vi.fn() } as never,
    })
    useMailStore.setState({
      emails: {},
      mailState: {},
      inboxFilter: null,
      folder: 'inbox',
    })
    useSettingsStore.setState({
      settings: {},
      loaded: true,
      loading: false,
    })

    renderSidebar(ALIASES.slice(0, 4))

    for (const address of ALIASES.slice(0, 4)) {
      expect(screen.getByText(address)).toBeInTheDocument()
    }
    expect(
      screen.queryByRole('button', { name: /all addresses/i }),
    ).not.toBeInTheDocument()
  })
})
