/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { nip19 } from 'nostr-tools'
import '@/app/components/test-utils'
import { DnsPanel } from './DnsPanel'
import { SetupProgress, VerifyStatus } from './presenters'
import { AddMemberForm, MemberRow } from './members'
import { buildSteps } from './workspaceUi'
import type { DomainDnsRecords, WorkspaceMember } from '@/app/lib/api/workspace'

const HEX = 'a'.repeat(64)
const NPUB = nip19.npubEncode(HEX)

const DNS: DomainDnsRecords = {
  verify: { name: '_mailstr-verify.acme.com', type: 'TXT', value: 'token-123' },
  mx: { name: 'acme.com', type: 'MX', value: 'mails.stg.mailstr.app', priority: 10 },
  spf: { name: 'acme.com', type: 'TXT', value: 'v=spf1 mx ~all' },
  dkim: { name: 'dkim._domainkey.acme.com', type: 'TXT', value: 'v=DKIM1; k=rsa; p=ABC' },
  dmarc: {
    name: '_dmarc.acme.com',
    type: 'TXT',
    value: 'v=DMARC1; p=reject; rua=mailto:postmaster@acme.com',
  },
}

function renderDns(status: 'pending' | 'active') {
  return render(
    <DnsPanel
      domain="acme.com"
      dns={DNS}
      status={status}
      verifiedAt={status === 'active' ? '2026-01-01T00:00:00Z' : null}
      busy={false}
      message={null}
      loading={false}
      onVerify={() => {}}
      onRotate={() => {}}
    />,
  )
}

describe('VerifyStatus', () => {
  it('says Verified with the date when active, Pending otherwise', () => {
    const { rerender } = render(<VerifyStatus status="pending" />)
    expect(screen.getByText(/pending verification/i)).toBeInTheDocument()
    rerender(<VerifyStatus status="active" verifiedAt="2026-01-01T00:00:00Z" />)
    expect(screen.getByText(/verified/i)).toBeInTheDocument()
  })
})

describe('DnsPanel', () => {
  it('shows the verification record first, and hides mail records until verified', () => {
    renderDns('pending')
    expect(screen.getByText('token-123')).toBeInTheDocument()
    // MX/SPF/DKIM/DMARC are not rendered yet.
    expect(screen.queryByText('mails.stg.mailstr.app')).not.toBeInTheDocument()
    expect(screen.queryByText(/v=DKIM1/)).not.toBeInTheDocument()
  })

  it('reveals MX/SPF/DKIM/DMARC once verified, with the live DKIM value', () => {
    renderDns('active')
    expect(screen.getByText(/mails\.stg\.mailstr\.app/)).toBeInTheDocument()
    expect(screen.getByText(/v=DKIM1; k=rsa; p=ABC/)).toBeInTheDocument()
    expect(screen.getByText(/v=DMARC1; p=reject/)).toBeInTheDocument()
  })

  it('lets an owner reveal the mail records before verification', async () => {
    const user = userEvent.setup()
    renderDns('pending')
    await user.click(screen.getByRole('button', { name: /show mail records anyway/i }))
    expect(screen.getByText(/v=DKIM1/)).toBeInTheDocument()
  })

  it('shows the record type before name/value and offers an info note', () => {
    renderDns('active')
    // One row per record, each carrying its type label.
    expect(screen.getAllByText('TXT').length).toBeGreaterThanOrEqual(4)
    expect(screen.getByText('MX')).toBeInTheDocument()
    // The info affordance explains why the record is needed.
    expect(
      screen.getByLabelText(/about the DMARC policy record/i),
    ).toBeInTheDocument()
  })
})

describe('AddMemberForm', () => {
  it('fills the signed-in identity with "Add my identity"', async () => {
    const user = userEvent.setup()
    render(
      <AddMemberForm
        active={{} as never}
        domain="acme.com"
        disabled={false}
        ownPubkey={HEX}
        onAssigned={() => {}}
      />,
    )
    expect(screen.getByLabelText('Identity pubkey')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: /add my identity/i }))
    expect(screen.getByLabelText('Identity pubkey')).toHaveValue(NPUB)
  })

  it('explains that hex and npub are the same key', () => {
    render(
      <AddMemberForm
        active={{} as never}
        domain="acme.com"
        disabled={false}
        ownPubkey={HEX}
        onAssigned={() => {}}
      />,
    )
    expect(screen.getByText(/same key in raw form/i)).toBeInTheDocument()
  })
})

describe('SetupProgress', () => {
  it('renders a breadcrumb trail with the current step emphasised', () => {
    render(<SetupProgress steps={buildSteps({ active: false, seatsUsed: 0 })} />)
    const trail = screen.getByRole('list', { name: /setup progress/i })
    // Every step appears as a crumb, and the current one is marked.
    expect(within(trail).getByText('Add your domain')).toBeInTheDocument()
    expect(within(trail).getByText('Publish the DNS records')).toBeInTheDocument()
    expect(trail.querySelector('[aria-current="step"]')).toHaveTextContent(
      'Publish the DNS records',
    )
  })
})

describe('MemberRow', () => {
  it('lists every address a member holds, each revocable', () => {
    const member: WorkspaceMember = {
      id: 1,
      domain_id: 12,
      pubkey: 'b'.repeat(64),
      role: 'member',
      status: 'active',
      nip05_id: 5,
      addresses: [
        { id: 1, member_id: 1, nip05_id: 5, status: 'active', address: 'alice@acme.com', local_part: 'alice' },
        { id: 2, member_id: 1, nip05_id: 6, status: 'active', address: 'contact@acme.com', local_part: 'contact' },
      ],
    }
    const onRevoke = vi.fn()
    const { container } = render(
      <MemberRow
        member={member}
        domain="acme.com"
        busy={false}
        onRevokeAddress={onRevoke}
        onRemove={() => {}}
      />,
    )
    expect(within(container).getByText('alice@acme.com')).toBeInTheDocument()
    expect(within(container).getByText('contact@acme.com')).toBeInTheDocument()
    expect(container.querySelectorAll('button[aria-label^="Revoke"]').length).toBe(2)
  })
})
