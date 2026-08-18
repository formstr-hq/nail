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

// A relay always appended to a recipient's resolved DM relays when forwarding
// mail, so outbound publishes also land here. Set via env; when empty the
// behaviour is skipped. A reliability measure until we run our own relay.
export const FIXED_RELAY = (process.env.FIXED_RELAY ?? "").trim();

export const config = {
  lmtpPort: Number(process.env.LMTP_PORT ?? 2400),
  // Internal mail-send API (welcome mail, receipts, ...). Disabled unless a key
  // is set — an unauthenticated sender would let anyone originate mail as us.
  sendApiKey: process.env.SEND_API_KEY,
  sendApiPort: Number(process.env.SEND_API_PORT ?? 2500),
  bridgePrivkey,
  bridgePubkey: getPublicKey(bridgePrivkey),
  nip05BaseUrl: process.env.NIP05_BASE_URL,
  bootstrapRelays: (process.env.BOOTSTRAP_RELAYS ?? "wss://relay.primal.net,wss://nos.lol")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  defaultRelayUrl: process.env.DEFAULT_RELAY_URL ?? "wss://relay.primal.net",
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
  bridgeRelays: (process.env.BRIDGE_RELAYS ?? process.env.BOOTSTRAP_RELAYS ?? "wss://relay.primal.net,wss://nos.lol")
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

// Wire-format kinds are re-exported from the protocol module rather than
// redeclared. They are part of the format the bridge and the client must agree
// on, and the protocol module exists so exactly one definition of that format
// ships to both. Two literals here would be free to drift apart silently.
export { KIND_MAIL as MAIL_KIND, KIND_GIFTWRAP as GIFT_WRAP_KIND } from "./protocol/constants.js";
