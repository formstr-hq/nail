/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './test-utils'
import { useAccountStore } from '@/app/store/account'
import { useSettingsStore } from '@/app/store/settings'
import { saveSettings } from '@/app/lib/nostr/settings'
import { isOnboardingSkipped } from '@/app/lib/onboardingSkip'
import { OnboardingModal } from './OnboardingModal'

const relayMocks = vi.hoisted(() => ({
  fetchDmRelayList: vi.fn(),
  publishDmRelays: vi.fn(),
}))

vi.mock('@/app/lib/nostr/relays', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/nostr/relays')>()),
  fetchDmRelayList: relayMocks.fetchDmRelayList,
  publishDmRelays: relayMocks.publishDmRelays,
}))

const PUBKEY = 'a'.repeat(64)
const STATUS = { phase: 'live' as const, relays: ['wss://one.example'], decoding: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  relayMocks.fetchDmRelayList.mockResolvedValue({
    relays: ['wss://one.example', 'wss://two.example'],
    hasList: true,
  })
  relayMocks.publishDmRelays.mockResolvedValue(undefined)
  useAccountStore.setState({
    account: { pubkey: PUBKEY } as never,
    active: { signEvent: vi.fn() } as never,
  })
  useSettingsStore.setState({ settings: {}, loaded: true, loading: false })
})

/** Render a returning account (has a list, so Skip is offered). */
async function renderHasList() {
  const onSkipped = vi.fn()
  render(<OnboardingModal status={STATUS} onSkipped={onSkipped} />)
  const skip = await screen.findByRole('button', { name: /skip for now/i })
  const confirm = screen.getByRole('button', { name: /confirm relays/i })
  await waitFor(() => expect(confirm).toBeEnabled())
  return { onSkipped, skip, confirm }
}

describe('OnboardingModal', () => {
  it('skips without publishing relays or syncing a settings write', async () => {
    const user = userEvent.setup()
    const { onSkipped, skip } = await renderHasList()

    await user.click(skip)

    expect(relayMocks.publishDmRelays).not.toHaveBeenCalled()
    expect(vi.mocked(saveSettings)).not.toHaveBeenCalled()
    expect(onSkipped).toHaveBeenCalledTimes(1)
    expect(isOnboardingSkipped(PUBKEY)).toBe(true)
  })

  it('does not republish an unchanged relay list on confirm', async () => {
    const user = userEvent.setup()
    const { confirm } = await renderHasList()

    await user.click(confirm)

    await waitFor(() => expect(vi.mocked(saveSettings)).toHaveBeenCalledTimes(1))
    expect(relayMocks.publishDmRelays).not.toHaveBeenCalled()
  })

  it('publishes when the user actually changes the list', async () => {
    const user = userEvent.setup()
    const { confirm } = await renderHasList()

    await user.type(
      screen.getByPlaceholderText('wss://relay.example.com'),
      'wss://three.example',
    )
    await user.click(screen.getByRole('button', { name: /^add$/i }))
    await user.click(confirm)

    await waitFor(() => expect(relayMocks.publishDmRelays).toHaveBeenCalledTimes(1))
    expect(relayMocks.publishDmRelays.mock.calls[0][0]).toContain('wss://three.example')
  })
})
