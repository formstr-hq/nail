import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { config } from "./config.js";
import { keySigner } from "./protocol/key-signer.js";
import { publishBridgeIdentity } from "./self-publish.js";
import { createLmtpServer } from "./lmtp-server.js";
import { UserResolver } from "./user-resolver.js";
import { createPostfixTransport } from "./smtp-injector.js";
import { startNostrListener } from "./nostr-listener.js";

useWebSocketImplementation(WebSocket);

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
