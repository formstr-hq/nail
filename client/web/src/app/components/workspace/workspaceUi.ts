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
 * Written for someone who has never added a DNS record: a plain name, why it
 * matters in one sentence, and where it goes in the words a DNS provider uses.
 * Keeping the copy here means the panel stays a presenter and the wording can
 * be unit-tested.
 */
export interface DnsHelp {
  /** Plain-language name for the record. */
  label: string
  /** One line: what it does, and what breaks without it. */
  why: string
  /** Where it goes, in DNS-provider terms. */
  where: string
}

export const DNS_HELP: Record<keyof DomainDnsRecords, DnsHelp> = {
  verify: {
    label: 'Prove you own this domain',
    why: 'A one-time code. It proves the domain is yours, so nobody else can claim it and receive its mail.',
    where: 'Add it as a new TXT record — you will not need it again after verifying.',
  },
  mx: {
    label: 'Where to deliver your mail',
    why: 'Tells the rest of the internet which server receives mail for your domain. Without it, incoming mail has nowhere to go.',
    where: 'Add it as a new MX record on your domain.',
  },
  spf: {
    label: 'Who is allowed to send your mail',
    why: 'Says our mail server is allowed to send email as your domain. Without it, your outgoing mail is far more likely to land in spam.',
    where: 'Add it as a new TXT record on your domain.',
  },
  dkim: {
    label: 'Your mail signature key',
    why: 'A public key that lets the people you email cryptographically check that your mail is really from you. We create it when your domain is verified.',
    where: 'Add it as a new TXT record, using the exact name shown.',
  },
  dmarc: {
    label: 'What to do with fake mail',
    why: 'Tells email providers what to do with messages pretending to be you. We say reject, so forged mail from your domain is refused.',
    where: 'Add it as a new TXT record, using the exact name shown.',
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
