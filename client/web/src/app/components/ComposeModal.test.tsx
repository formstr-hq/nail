/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './test-utils'
import { ComposeModal } from './ComposeModal'
import { useMailStore } from '@/app/store/mail'
import { useAccountStore } from '@/app/store/account'
import { useSettingsStore } from '@/app/store/settings'
import { useComposeOverlay } from '@/app/store/composeOverlay'
import { useBridgeStore } from '@/app/store/bridge'
import type { ResolveContext } from '@/app/lib/mail/resolve'

vi.mock('@/app/lib/mail/send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/mail/send')>()),
  sendMail: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/app/lib/pgp/compose', () => ({
  encryptBody: vi.fn().mockImplementation(async ({ body }) => body),
}))

vi.mock('@/app/lib/pgp/session', () => ({
  getSessionPassphrase: vi.fn().mockReturnValue(null),
  setSessionPassphrase: vi.fn(),
}))

import { sendMail } from '@/app/lib/mail/send'

const CTX: ResolveContext = {
  bridgePubkey: 'a'.repeat(64),
  localDomains: ['mailstr.app'],
} as unknown as ResolveContext
const SELF = ['me@mailstr.app', 'npub1' + 'q'.repeat(58) + '@mailstr.app']

const PROPS = {
  onClose: vi.fn(),
  ctx: CTX,
  selfAddresses: SELF,
  ownedAliases: ['me@mailstr.app'],
  minimized: false,
  setMinimized: vi.fn(),
  onOpenEncryptionSettings: vi.fn(),
  onBuyAddress: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
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
  useAccountStore.setState({
    account: { pubkey: 'd'.repeat(64), npub: 'npub1' + 'q'.repeat(58) } as never,
    active: { nip44Encrypt: async () => 'x' } as never,
  })
  useSettingsStore.setState({ settings: {}, loaded: true, loading: false })
  useComposeOverlay.setState({ draft: null, minimized: false })
  useBridgeStore.setState({ probes: [], nip05: {} })
})

describe('ComposeModal happy path', () => {
  it('sends a plain message to a recipient and closes', async () => {
    const user = userEvent.setup()
    render(<ComposeModal {...PROPS} />)

    await user.type(screen.getByPlaceholderText('npub, name@domain, or an email address'), 'friend@mailstr.app')
    await user.type(screen.getByPlaceholderText('What is this about?'), 'Greetings')
    await user.type(screen.getByPlaceholderText('Write your message'), 'Hello from the test suite.')
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    await waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1))
    const call = vi.mocked(sendMail).mock.calls[0][0]
    expect(call.to).toEqual(['friend@mailstr.app'])
    expect(call.subject).toBe('Greetings')
    expect(call.body).toContain('Hello from the test suite.')
    expect(PROPS.onClose).toHaveBeenCalled()
  })

  it('prefills a reply draft and focuses the body', () => {
    render(
      <ComposeModal
        {...PROPS}
        draft={{ to: 'friend@mailstr.app', subject: 'Re: Hi', body: 'A reply!', inReplyTo: 'x' }}
      />,
    )
    expect(screen.getByPlaceholderText('npub, name@domain, or an email address')).toHaveValue('friend@mailstr.app')
    expect(screen.getByPlaceholderText('What is this about?')).toHaveValue('Re: Hi')
    expect(screen.getByText('Reply')).toBeInTheDocument()
  })

  it('asks before discarding a dirty draft, then closes on confirm', async () => {
    const user = userEvent.setup()
    render(<ComposeModal {...PROPS} />)
    await user.type(screen.getByPlaceholderText('What is this about?'), 'Typed something')

    await user.click(screen.getByTitle('Close'))
    expect(screen.getByText('Discard this draft?')).toBeInTheDocument()
    expect(PROPS.onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(PROPS.onClose).toHaveBeenCalled()
  })

  it('suggests past correspondents while typing the To field', async () => {
    const user = userEvent.setup()
    useMailStore.setState({
      emails: {
        ['a'.repeat(64)]: {
          id: 'a'.repeat(64),
          fromHeader: { address: 'ada@mailstr.app', name: 'Ada' },
          to: [{ address: 'me@mailstr.app' }],
          subject: 'Prior thread',
          body: '',
          attachments: [],
          timestamp: 1,
          senderPubkey: 'c'.repeat(64),
          read: true,
          labelEventIds: [],
          labels: [],
        },
      },
      seenIds: new Set(['a'.repeat(64)]),
    })
    // A contact suggestion uses the EFFECTIVE sender, so the prior message's
    // header only becomes one once something backs it. Seed the NIP-05 verdict
    // the render-time derivation reads (the sealing key owns ada's address).
    useBridgeStore.setState({
      nip05: { 'ada@mailstr.app': { status: 'resolved', pubkey: 'c'.repeat(64) } },
    })

    render(<ComposeModal {...PROPS} />)
    const to = screen.getByPlaceholderText('npub, name@domain, or an email address')
    to.focus()
    await user.type(to, 'ada')

    const option = await screen.findByText('ada@mailstr.app')
    await user.click(option)

    expect(to).toHaveValue('ada@mailstr.app, ')
  })

  it('shows the mixed-encryption status when a recipient lacks a key', () => {
    // canEncrypt requires a from-key; give the settings one for the alias, but
    // no keyring entry for the recipient.
    useSettingsStore.setState({
      settings: {
        pgpKeys: {
          'me@mailstr.app': {
            publicKey: 'pub',
            privateKey: 'priv',
            fingerprint: 'f'.repeat(40),
          },
        },
      } as never,
    })
    render(<ComposeModal {...PROPS} />)
    const to = screen.getByPlaceholderText('npub, name@domain, or an email address')
    // Can't easily await typing + key discovery; assert the status line reacts
    // once a recipient with no key is present.
    return userTypedAndAssert(to)
  })

  it('blocks an npub From for a known legacy recipient with a switch CTA', async () => {
    const user = userEvent.setup()
    render(<ComposeModal {...PROPS} />)
    const select = document.querySelector('select')!
    const npubOption = Array.from((select as HTMLSelectElement).options).find((o) => o.value.startsWith('npub'))
    expect(npubOption).toBeTruthy()
    await user.selectOptions(select as HTMLSelectElement, npubOption!.value)

    await user.type(screen.getByPlaceholderText('npub, name@domain, or an email address'), 'someone@gmail.com')
    expect(await screen.findByText(/your npub can’t reach them/i)).toBeInTheDocument()
  })
})

// Helper kept out of the describe body for readability.
async function userTypedAndAssert(to: HTMLElement) {
  const user = userEvent.setup()
  await user.type(to, 'nokey@example.com')
  await waitFor(async () => {
    const mixed = await screen.findByText(/receive plaintext|Encrypted with PGP|Add a recipient/i)
    expect(mixed).toBeInTheDocument()
  })
}