import WebSocket from "ws";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { config } from "./config.js";
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
