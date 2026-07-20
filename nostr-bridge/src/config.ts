import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parsePrivkey(envVar: string): Uint8Array {
  const value = required(envVar);
  if (value.startsWith("nsec1")) {
    const decoded = decode(value);
    if (decoded.type !== "nsec") throw new Error(`${envVar} is not a valid nsec`);
    return decoded.data;
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

const bridgePrivkey = parsePrivkey("NOSTR_BRIDGE_NSEC");

export const config = {
  lmtpPort: Number(process.env.LMTP_PORT ?? 2400),
  bridgePrivkey,
  bridgePubkey: getPublicKey(bridgePrivkey),
  nip05BaseUrl: process.env.NIP05_BASE_URL,
  bootstrapRelays: (process.env.BOOTSTRAP_RELAYS ?? "wss://relay.damus.io,wss://relay.nostr.band")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  defaultRelayUrl: process.env.DEFAULT_RELAY_URL ?? "wss://relay.damus.io",
  relayCacheMax: Number(process.env.RELAY_CACHE_MAX ?? 1000),
  relayCacheTtlMs: Number(process.env.RELAY_CACHE_TTL_MS ?? 3600000),
  postfixHost: process.env.POSTFIX_HOST ?? "postfix",
  postfixPort: Number(process.env.POSTFIX_PORT ?? 25),
  blossomServerUrl: process.env.BLOSSOM_SERVER_URL ?? "https://nostr.download",
  bridgeDomain: process.env.BRIDGE_DOMAIN ?? "",
  // Domains this deployment accepts mail for and serves NIP-05 records for.
  // Outbound From addresses MUST be on one of these (§5); the bridge refuses
  // to deliver TO them (§6B step 5) since they are reachable over Nostr.
  localDomains: (process.env.LOCAL_DOMAINS ?? process.env.ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Relays the bridge itself listens and publishes its own 10050/kind-0 on.
  bridgeRelays: (process.env.BRIDGE_RELAYS ?? process.env.BOOTSTRAP_RELAYS ?? "wss://relay.damus.io,wss://relay.nostr.band")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

// Fail fast rather than silently running as an open relay: with no local
// domains configured there is no address the bridge can verify ownership of,
// so every outbound message would have to be rejected anyway (§5).
if (config.localDomains.length === 0) {
  throw new Error(
    "Missing required env var: LOCAL_DOMAINS (comma-separated, e.g. mailstr.app)",
  );
}

export const MAIL_KIND = 1301;
export const GIFT_WRAP_KIND = 1059;
export const HEARTBEAT_KIND = 1;
export const HEARTBEAT_PREFIX = "nostr-bridge-heartbeat:";
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const MAX_MISSED_HEARTBEATS = 3;
