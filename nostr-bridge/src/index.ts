import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { config } from "./config.js";
import { keySigner } from "./protocol/key-signer.js";
import { publishBridgeIdentity } from "./self-publish.js";
import { createLmtpServer } from "./lmtp-server.js";
import { UserResolver } from "./user-resolver.js";
import { createPostfixTransport } from "./smtp-injector.js";
import { startNostrListener } from "./nostr-listener.js";
import { createSendApp } from "./send-service.js";
import { RelayWebSocket } from "./relay-socket.js";

useWebSocketImplementation(RelayWebSocket);

const userResolver = new UserResolver(
  config.bootstrapRelays,
  config.bridgeRelays,
  config.relayCacheMax,
  config.relayCacheTtlMs,
);

const lmtpServer = createLmtpServer(userResolver);
lmtpServer.listen(config.lmtpPort, () => {
  console.log(`nostr-bridge: LMTP listening on ${config.lmtpPort}`);
});

const postfixTransport = createPostfixTransport(config.postfixHost, config.postfixPort);

// Internal mail-send API — only started when a key is configured, so a
// deployment that never wires it up stays closed rather than open by default.
if (config.sendApiKey) {
  const sendApp = createSendApp({
    apiKey: config.sendApiKey,
    signer: keySigner(config.bridgePrivkey),
    userResolver,
    localDomains: config.localDomains,
    nip05BaseUrl: config.nip05BaseUrl,
  });
  sendApp.listen(config.sendApiPort, () => {
    console.log(`nostr-bridge: send API listening on ${config.sendApiPort}`);
  });
} else {
  console.log("nostr-bridge: send API disabled (SEND_API_KEY unset)");
}

startNostrListener(postfixTransport).catch((err) => {
  console.error("nostr-bridge: nostr listener failed to start:", err);
  process.exit(1);
});

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
