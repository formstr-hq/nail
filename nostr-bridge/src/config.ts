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
  allowedDomains: (process.env.ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
