import { createServer } from "node:http";
import { config } from "./config.js";
import { healthSnapshot } from "./nostr-listener.js";

/**
 * A minimal always-on HTTP health endpoint.
 *
 * `GET /healthz` returns 200 when the receive-path self-test round-tripped
 * within the last interval, else 503. This is what the Docker HEALTHCHECK polls,
 * so orchestrators see *real* gift-wrap receive health rather than a bare TCP
 * connect to the LMTP port (which stays open even when every relay socket is
 * dead). Self-healing itself is the watchdog's job — it exits and lets Docker
 * restart the process; this endpoint is visibility only.
 */
export function startHealthServer(): void {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      const snap = healthSnapshot();
      res.writeHead(snap.healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snap));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // An EventEmitter `error` with no listener throws. A busy port must be a
  // logged, visible failure — not a stack-less process death whose cause
  // Docker swallows on restart.
  server.on("error", (err) => {
    console.error(`nostr-bridge: health endpoint error on :${config.healthPort}:`, err.message);
  });

  server.listen(config.healthPort, () => {
    console.log(`nostr-bridge: health endpoint on :${config.healthPort}/healthz`);
  });
}
