// Outbound bridge domain. Override per-deploy with VITE_BRIDGE_DOMAIN
// (e.g. stg.mailstr.app for staging); the well-known _smtp record must be
// served there with a CORS-open Access-Control-Allow-Origin header.
export const BRIDGE_DOMAIN =
  import.meta.env.VITE_BRIDGE_DOMAIN ?? 'mailstr.app'
export const BRIDGE_NIP05_NAME = '_smtp'

export const KIND_MAIL = 1301
export const KIND_GIFTWRAP = 1059
export const KIND_DM_RELAYS = 10050
export const KIND_NIP65_RELAYS = 10002
export const KIND_LABEL = 1985
export const KIND_SETTINGS = 30078

export const LABEL_NAMESPACE = 'mail'

// Overridable so the e2e suite can point the whole app at a single local mock
// relay (VITE_DEFAULT_RELAYS=ws://localhost:PORT); production uses the built-in
// public set.
const DEFAULT_RELAYS_RAW: string =
  (import.meta.env.VITE_DEFAULT_RELAYS as string | undefined) ??
  'wss://nos.lol,wss://relay.primal.net,wss://relay.snort.social'

export const DEFAULT_RELAYS: string[] = DEFAULT_RELAYS_RAW.split(',')
  .map((r) => r.trim())
  .filter(Boolean)

// A relay we always send to and read from, no matter what the account's own
// NIP-17 (10050) / NIP-65 (10002) lists say. Per-recipient resolution still
// runs; this is unioned into the result so mail is also published here and the
// kind-1059 stream also reads from here.
//
// Disabled when VITE_DEFAULT_RELAYS is set — the e2e suite points the whole
// app at a single local mock relay and must stay isolated from the public
// network.
export const HARDCODED_RELAY = 'wss://relay.primal.net'
const RELAY_OVERRIDE_ACTIVE = Boolean(import.meta.env.VITE_DEFAULT_RELAYS)

export function withHardcodedRelay(relays: string[]): string[] {
  if (RELAY_OVERRIDE_ACTIVE) return relays
  return [...new Set([...relays, HARDCODED_RELAY])]
}

// NIP-44 / NIP-59 plaintext size limit
export const BLOSSOM_THRESHOLD_BYTES = 60_000
