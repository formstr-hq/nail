// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Email } from '@/types/mail'

// Regression guard for the "rendered fewer hooks than expected" crash on
// PGP mail. MessageBody used to call useMemo/useEffect *after* the early
// returns for the PGP states, so once usePgpMessage flipped from 'none' to
// 'decrypted' after the async decrypt, the re-render ran fewer hooks and React
// threw. This mock reproduces exactly that transition — 'none' on mount, then
// 'decrypted' from an effect — without pulling in openpgp or a real keyring.
vi.mock('@/hooks/usePgpMessage', async () => {
  const { useEffect, useState } = await import('react')
  return {
    usePgpMessage: () => {
      const [state, setState] = useState<{ kind: string; [k: string]: unknown }>({ kind: 'none' })
      useEffect(() => {
        setState({
          kind: 'decrypted',
          text: 'the secret plaintext',
          signature: { status: 'valid', keyID: 'deadbeef' },
        })
      }, [])
      return state
    },
  }
})

import { MessageBody } from './EmailView'

function pgpEmail(): Email {
  return {
    id: 'evt1',
    from: { name: 'Me', address: 'npub1me@mailstr.app' },
    to: [{ address: 'npub1them@mailstr.app' }],
    subject: 'sealed',
    // A body that is not renderable as HTML, so the pre-decrypt render takes the
    // plaintext branch (no iframe/ResizeObserver needed under jsdom).
    body: '-----BEGIN PGP MESSAGE-----\nwcBMA...\n-----END PGP MESSAGE-----',
    attachments: [],
    timestamp: 1,
    senderPubkey: 'abc123',
    senderProof: 'own-seal',
    read: true,
    labelEventIds: [],
    labels: [],
  }
}

afterEach(() => cleanup())

describe('MessageBody (PGP read path)', () => {
  it('renders the decrypted body without a hooks-count crash when decrypt resolves after mount', async () => {
    // A render that threw would surface here (React rethrows during act()).
    render(<MessageBody email={pgpEmail()} />)

    // The plaintext appears only after the mocked decrypt flips state on the
    // second render — the exact render that used to crash.
    await waitFor(() => {
      expect(screen.getByText('the secret plaintext')).toBeTruthy()
    })
    // And the honest "Decrypted · …" verdict badge is shown.
    expect(screen.getByText(/Decrypted/)).toBeTruthy()
  })
})
