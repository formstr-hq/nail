import type { DomainDnsRecords } from '@/app/lib/api/workspace'
import { nip19 } from 'nostr-tools'

/**
 * Decode an npub to hex, or accept an already-hex key. Null if neither.
 *
 * Admins copy a Nostr identity out of whichever client they use; npub and hex
 * are the same key, so both are accepted and normalized to the hex the backend
 * stores.
 */
export function decodePubkey(input: string): string | null {
  const value = input.trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  if (value.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(value)
      if (decoded.type === 'npub') return decoded.data as string
    } catch {
      return null
    }
  }
  return null
}

/** Shorten a hex pubkey for display, keeping both ends. */
export function shortPubkey(pubkey: string): string {
  if (pubkey.length <= 16) return pubkey
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`
}

/**
 * Per-record copy for the workspace DNS panel.
 *
 * The UI shows the record *type* first (that is what a DNS provider asks for),
 * with an info affordance explaining what the record is and why it is needed.
 * Keeping the copy here means the panel stays a presenter and the wording can
 * be unit-tested.
 */
export interface DnsHelp {
  /** Human name for the record. */
  label: string
  /** One line: what it does. */
  why: string
  /** Where it goes, in DNS-provider terms. */
  where: string
}

export const DNS_HELP: Record<keyof DomainDnsRecords, DnsHelp> = {
  verify: {
    label: 'Domain verification',
    why: 'Proves to us that you control the domain, so nobody else can claim it and receive its mail.',
    where: 'TXT record at the verification name shown below',
  },
  mx: {
    label: 'Mail server',
    why: 'Tells the internet which server accepts mail for your domain. Without it, inbound mail has nowhere to go.',
    where: 'MX record on the domain itself',
  },
  spf: {
    label: 'Sender policy',
    why: 'Authorizes our mail server to send as your domain. Without it, your outbound mail is more likely to be marked as spam.',
    where: 'TXT record on the domain itself',
  },
  dkim: {
    label: 'DKIM signature',
    why: 'A public key that lets recipients cryptographically verify mail sent from your domain. It is generated when your domain is verified.',
    where: 'TXT record at the DKIM selector shown below',
  },
  dmarc: {
    label: 'DMARC policy',
    why: 'Tells receivers what to do when a message fails SPF or DKIM. We publish p=reject, so forged mail from your domain is rejected outright.',
    where: 'TXT record at the _dmarc name shown below',
  },
}

/**
 * Display order: verification first (the gate), then the records that make the
 * domain deliverable once verified.
 */
export const DNS_ORDER: (keyof DomainDnsRecords)[] = [
  'verify',
  'mx',
  'spf',
  'dkim',
  'dmarc',
]

/** The records that keep mail flowing after verification. */
export const MAIL_RECORD_KEYS: (keyof DomainDnsRecords)[] = ['mx', 'spf', 'dkim', 'dmarc']

export interface SetupStep {
  id: 'add' | 'dns' | 'verify' | 'addresses' | 'send'
  title: string
  detail: string
  state: 'done' | 'current' | 'todo'
}

/**
 * Derive the setup progress from what we actually know (verification state,
 * seats used), rather than storing a step index that could drift from reality.
 */
export function buildSteps(input: {
  active: boolean
  seatsUsed: number
}): SetupStep[] {
  const { active, seatsUsed } = input
  const addressesAssigned = seatsUsed > 0
  return [
    {
      id: 'add',
      title: 'Add your domain',
      detail: 'Registered and waiting for DNS.',
      state: 'done',
    },
    {
      id: 'dns',
      title: 'Publish the DNS records',
      detail: 'Add the records below at your DNS provider.',
      state: active ? 'done' : 'current',
    },
    {
      id: 'verify',
      title: 'Verify the domain',
      detail: active
        ? 'Ownership confirmed.'
        : 'Run verification once the records have propagated.',
      state: active ? 'done' : 'todo',
    },
    {
      id: 'addresses',
      title: 'Assign addresses',
      detail: addressesAssigned
        ? 'Members have addresses.'
        : 'Give people an address on your domain.',
      state: addressesAssigned ? 'done' : active ? 'current' : 'todo',
    },
    {
      id: 'send',
      title: 'Mail flows',
      detail: active && addressesAssigned ? 'Ready to send and receive.' : 'Send and receive mail.',
      state: active && addressesAssigned ? 'done' : 'todo',
    },
  ]
}
