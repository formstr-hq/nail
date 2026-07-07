import { createServer } from "node:http";
import type { Server } from "node:http";

const registrations = new Map<string, string>();

let nip05Server: Server | null = null;

/** Register a NIP-05 name → pubkey mapping for the mock server. */
export function registerNip05(localPart: string, pubkey: string): void {
  registrations.set(localPart.toLowerCase(), pubkey);
}

/** Start the NIP-05 mock HTTP server (serves /.well-known/nostr.json). */
export function startNip05Server(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    nip05Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/.well-known/nostr.json") {
        const name = url.searchParams.get("name")?.toLowerCase();
        const pubkey = name ? registrations.get(name) : undefined;
        if (pubkey && name) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ names: { [name]: pubkey } }));
        } else {
          res.writeHead(404);
          res.end();
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    nip05Server.once("error", reject);
    nip05Server.listen(port, "0.0.0.0", () => resolve());
  });
}

/** Stop the NIP-05 mock HTTP server. */
export function stopNip05Server(): Promise<void> {
  registrations.clear();
  if (!nip05Server) return Promise.resolve();
  return new Promise((resolve, reject) =>
    nip05Server!.close((err) => (err ? reject(err) : resolve())),
  );
}
