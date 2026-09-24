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

/**
 * How much larger a kind-1059 wrap event is than the raw message it carries.
 *
 * Measured against the deployed relay set: 24.6 KiB raw → 55.1 KiB event,
 * 32.8 KiB → 77.0 KiB. Two NIP-44 layers, each base64-armored, inflate the
 * content — and because NIP-44 pads to fixed chunk sizes, the ratio steps
 * rather than growing smoothly (1.97x-2.70x observed on ASCII mail). 2.4 is
 * the working figure; non-ASCII mail (multi-byte UTF-8, base64-heavy bodies)
 * can exceed it, which is why the ceiling is a conservative gate, not an
 * estimate of the exact event size.
 */
const WRAP_INFLATION = 2.4;

/** Largest kind-1059 wrap event the relays will carry — see the config field. */
const relayMaxEventBytes = Number(process.env.RELAY_MAX_EVENT_BYTES ?? 100 * 1024);

export const config = {
  lmtpPort: Number(process.env.LMTP_PORT ?? 2400),
  // Internal mail-send API (welcome mail, receipts, ...). Disabled unless a key
  // is set — an unauthenticated sender would let anyone originate mail as us.
  sendApiKey: process.env.SEND_API_KEY,
  sendApiPort: Number(process.env.SEND_API_PORT ?? 2500),
  bridgePrivkey,
  bridgePubkey: getPublicKey(bridgePrivkey),
  nip05BaseUrl: process.env.NIP05_BASE_URL,
  // Backend address resolver — the fallback for tenant (workspace) domains,
  // which have no well-known of their own. Empty disables the fallback, so
  // platform-only deployments behave as before.
  nip05ResolverUrl: process.env.NIP05_RESOLVER_URL ?? "",
  nip05ResolverKey: process.env.NIP05_RESOLVER_KEY ?? "",
  bootstrapRelays: (process.env.BOOTSTRAP_RELAYS ?? "wss://relay.formstr.app,wss://relay.primal.net,wss://nos.lol")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  defaultRelayUrl: process.env.DEFAULT_RELAY_URL ?? "wss://relay.formstr.app",
  relayCacheMax: Number(process.env.RELAY_CACHE_MAX ?? 1000),
  relayCacheTtlMs: Number(process.env.RELAY_CACHE_TTL_MS ?? 3600000),
  postfixHost: process.env.POSTFIX_HOST ?? "postfix",
  postfixPort: Number(process.env.POSTFIX_PORT ?? 25),

  // Postfix socketmap responder for tenant-domain routing (socketmap.ts).
  // Disabled at 0 so platform-only deployments keep their previous surface.
  socketmapPort: Number(process.env.SOCKETMAP_PORT ?? 0),
  // Where the responder learns which tenant domains are active. The backend
  // exposes this list; the bridge caches it.
  directoryUrl: process.env.DOMAIN_DIRECTORY_URL ?? "",
  directoryKey: process.env.DOMAIN_DIRECTORY_KEY ?? "",
  directoryTtlMs: Number(process.env.DOMAIN_DIRECTORY_TTL_MS ?? 5 * 60 * 1000),
  directoryNegativeTtlMs: Number(
    process.env.DOMAIN_DIRECTORY_NEGATIVE_TTL_MS ?? 60 * 1000,
  ),
  directoryMaxStaleMs: Number(
    process.env.DOMAIN_DIRECTORY_MAX_STALE_MS ?? 60 * 1000,
  ),
  // The nexthop the socketmap returns for tenant domains. LMTP into this
  // bridge, matching the platform domain's route.
  transportNexthop: process.env.TRANSPORT_NEXTHOP ?? "nostr-bridge:2400",
  // Hard cap on an inbound LMTP message the bridge will buffer in memory.
  // Messages above it are rejected with 552 during transfer rather than
  // buffered. Parsing and rebuilding a message peaks at several times its
  // size (measured ~5x for attachment mail), so this cap must fit the
  // container's memory limit alongside node's baseline (~50 MB): with the
  // stock 128 MB override that means keeping this at 8 MB or less.
  maxMessageBytes: Number(process.env.MAIL_MAX_BYTES ?? 8 * 1024 * 1024),

  // Largest kind-1059 wrap event the relays will carry. 100 KiB matches
  // relay.formstr.app's measured content cap (102400 — our own relay, so it
  // is the one that matters most). nos.lol and relay.nostr.com are stricter
  // and still answer "event too large" above 65536, so events between the two
  // land on formstr.app, primal and damus only.
  relayMaxEventBytes,

  // Largest raw message the bridge will seal and wrap. Derived from the relay
  // event cap above, because sealing holds the message as several full-size
  // copies: two NIP-44 layers, each base64-armored, make the event ~2.4x the
  // raw mail, and peak memory while sealing is ~150x. Attempting a full wrap
  // for a large attachment is what OOM-killed the 128 MB container, and the
  // relays that accept events this size are the minority — so above this the
  // bridge strips attachments first instead of paying the memory, then a
  // 451/552 retry, to reach only the permissive relays.
  maxWrappableMessageBytes: Math.floor(relayMaxEventBytes / WRAP_INFLATION),

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
  bridgeRelays: (process.env.BRIDGE_RELAYS ?? process.env.BOOTSTRAP_RELAYS ?? "wss://relay.formstr.app,wss://relay.primal.net,wss://nos.lol")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Receive-path watchdog (nostr-listener.ts). Every `healthIntervalMs` the
  // bridge gift-wraps a health ping to itself and waits `healthTimeoutMs` for it
  // to round-trip through the live subscription; on failure it exits so Docker
  // restarts it with fresh relay sockets. The first probe is delayed by a full
  // `healthIntervalMs` too, never fired on start-up, so a crash-restart loop
  // can't publish pings faster than one per interval and get us rate-limited.
  // `/healthz` (healthPort) reflects the last result for orchestrators.
  healthIntervalMs: Number(process.env.HEALTH_INTERVAL_MS ?? 60 * 60 * 1000),
  healthTimeoutMs: Number(process.env.HEALTH_TIMEOUT_MS ?? 30_000),
  healthPort: Number(process.env.HEALTH_PORT ?? 2510),
};

// Fail fast rather than silently running as an open relay: with no local
// domains configured there is no address the bridge can verify ownership of,
// so every outbound message would have to be rejected anyway (§5).
if (config.localDomains.length === 0) {
  throw new Error(
    "Missing required env var: LOCAL_DOMAINS (comma-separated, e.g. mailstr.app)",
  );
}

/**
 * Print the effective size limits at boot.
 *
 * These caps silently decide which mail is deliverable, and every one of them
 * is an env override that may differ between deployments — a 552'd message
 * looks inexplicable without knowing the numbers in force. Logging them makes
 * each deployment's actual policy visible in its first lines.
 */
export function logEffectiveLimits(): void {
  const kib = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`;
  console.log(
    "nostr-bridge: size limits — " +
      `max inbound message ${kib(config.maxMessageBytes)}, ` +
      `relay event cap ${kib(config.relayMaxEventBytes)} ` +
      `(raw-message ceiling ${kib(config.maxWrappableMessageBytes)}; ` +
      "mail above it is delivered without attachments)",
  );
}

// Wire-format kinds are re-exported from the protocol module rather than
// redeclared. They are part of the format the bridge and the client must agree
// on, and the protocol module exists so exactly one definition of that format
// ships to both. Two literals here would be free to drift apart silently.
export { KIND_MAIL as MAIL_KIND, KIND_GIFTWRAP as GIFT_WRAP_KIND } from "./protocol/constants.js";
