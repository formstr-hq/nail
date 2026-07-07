// Standalone nostr-mock-relay server for use as a Docker service.
// Both the nostr-bridge container and the e2e test runner connect to this relay.
import { createMockRelay } from "nostr-mock-relay";

const port = parseInt(process.env.PORT ?? "4600", 10);
const relay = createMockRelay({ host: "0.0.0.0", port });

await relay.start();
console.log(`nostr-mock-relay listening on ${relay.url}`);

process.on("SIGTERM", async () => {
  await relay.stop();
  process.exit(0);
});
