import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { registerFatalHandlers } from "./fatal.js";
import { config, logEffectiveLimits } from "./config.js";
import { keySigner } from "./protocol/key-signer.js";
import { publishBridgeIdentity } from "./self-publish.js";
import { createLmtpServer } from "./lmtp-server.js";
import { UserResolver } from "./user-resolver.js";
import { createPostfixTransport } from "./smtp-injector.js";
import { startNostrListener, handleWrap } from "./nostr-listener.js";
import { startHealthServer } from "./health-server.js";
import { createSendApp } from "./send-service.js";
import { RelayWebSocket } from "./relay-socket.js";
import { createSocketmapServer } from "./socketmap.js";
import { BackendDomainDirectory } from "./domain-directory.js";

// First thing, before any listener or socket exists: a crash during start-up
// must log its cause rather than vanishing into a Docker restart.
registerFatalHandlers();

// Make the deployment's size policy visible in the first lines: these caps
// decide which mail is deliverable, they differ per env override, and a 552
// is otherwise inexplicable from the logs.
logEffectiveLimits();

useWebSocketImplementation(RelayWebSocket);

// One pool shared by the relay subscription and the /v1/relay inject endpoint,
// so a directly-injected wrap runs the identical handleWrap path — same relays,
// same replay guard — as one that arrived over the subscription.
const pool = new SimplePool({ enableReconnect: true });

const userResolver = new UserResolver(
  config.bootstrapRelays,
  config.bridgeRelays,
  config.relayCacheMax,
  config.relayCacheTtlMs,
);

const lmtpServer = createLmtpServer(userResolver);
// smtp-server emits `error` for socket-level failures; an EventEmitter
// `error` with no listener throws, which would take the process down with a
// stack that names nothing useful. Log it and keep serving.
lmtpServer.on("error", (err: Error) => {
  console.error("nostr-bridge: LMTP server error:", err.message);
});
lmtpServer.listen(config.lmtpPort, () => {
  console.log(`nostr-bridge: LMTP listening on ${config.lmtpPort}`);
});

const postfixTransport = createPostfixTransport(config.postfixHost, config.postfixPort);

// Tenant-domain directory: the single source for "is this a managed domain?"
// on both inbound (socketmap) and outbound (handleWrap) paths. Created only
// when a directory URL is configured, so platform-only deployments keep
// exactly their previous behaviour.
const directory = config.directoryUrl
  ? new BackendDomainDirectory({
      platformDomains: config.localDomains,
      directoryUrl: config.directoryUrl,
      directoryKey: config.directoryKey || undefined,
      ttlMs: config.directoryTtlMs,
      negativeTtlMs: config.directoryNegativeTtlMs,
      maxStaleMs: config.directoryMaxStaleMs,
    })
  : null;

if (directory) {
  // Warm the cache so the first tenant message is not a cache miss. Failure
  // is non-fatal: the socketmap defers (TEMP) and outbound refuses tenant
  // domains (fail-closed) until a refresh succeeds.
  void directory
    .refresh()
    .then(() => console.log("nostr-bridge: tenant domain directory loaded"))
    .catch((err: Error) =>
      console.warn(
        `nostr-bridge: domain directory warm-up failed (will defer until reachable): ${err.message}`,
      ),
    );
}

// Postfix socketmap responder for tenant-domain routing (socketmap.ts). Only
// started when a port is configured; requires the directory to answer.
if (config.socketmapPort > 0 && directory) {
  const socketmapServer = createSocketmapServer({
    directory,
    platformDomains: config.localDomains,
    transportNexthop: config.transportNexthop,
  });
  socketmapServer.on("error", (err: Error) => {
    console.error("nostr-bridge: socketmap server error:", err.message);
  });
  socketmapServer.listen(config.socketmapPort, () => {
    console.log(`nostr-bridge: socketmap listening on ${config.socketmapPort}`);
  });
} else if (config.socketmapPort > 0) {
  console.warn(
    "nostr-bridge: socketmap requested but DOMAIN_DIRECTORY_URL is unset — not starting",
  );
} else {
  console.log("nostr-bridge: socketmap disabled (SOCKETMAP_PORT unset)");
}

// Internal mail-send API — only started when a key is configured, so a
// deployment that never wires it up stays closed rather than open by default.
if (config.sendApiKey) {
  const sendApp = createSendApp({
    apiKey: config.sendApiKey,
    signer: keySigner(config.bridgePrivkey),
    userResolver,
    localDomains: config.localDomains,
    nip05BaseUrl: config.nip05BaseUrl,
    // Feed injected wraps through the same receive path as the subscription.
    injectWrap: (event) =>
      handleWrap(pool, config.bridgeRelays, postfixTransport, event, directory ?? undefined),
  });
  // `app.listen` returns the http.Server, and that is where an `error` (e.g.
  // EADDRINUSE) is emitted — an unhandled one is a process death.
  const sendServer = sendApp.listen(config.sendApiPort, () => {
    console.log(`nostr-bridge: send API listening on ${config.sendApiPort}`);
  });
  sendServer.on("error", (err: Error) => {
    console.error(`nostr-bridge: send API error on :${config.sendApiPort}:`, err.message);
  });
} else {
  console.log("nostr-bridge: send API disabled (SEND_API_KEY unset)");
}

startNostrListener(pool, postfixTransport, directory ?? undefined).catch((err) => {
  console.error("nostr-bridge: nostr listener failed to start:", err);
  process.exit(1);
});

// Reports the receive-path self-test result at /healthz for the Docker
// HEALTHCHECK. Started after the listener so healthSnapshot() has meaning.
startHealthServer();

// Announce where to reach this bridge. Failure here is not fatal — mail still
// flows for anyone who already knows the pubkey — so it only warns.
void publishBridgeIdentity(
  new SimplePool(),
  config.bridgeRelays,
  keySigner(config.bridgePrivkey),
  config.localDomains[0],
).catch((err) => {
  console.error("nostr-bridge: failed to publish bridge identity:", (err as Error).message);
});
