import WebSocket from "ws";

/**
 * A browser-like User-Agent sent on every WebSocket upgrade to a relay.
 *
 * Some relays sit behind Cloudflare and reject the default `ws` User-Agent
 * (e.g. `relay.0xchat.com` answers the upgrade with HTTP 403). The rejection
 * happens at the TLS/HTTP layer, before any Nostr frame — NIP-42 AUTH can't
 * run because the socket never opens. Spoofing a browser UA gets past the
 * CDN gate; the relay itself still enforces whatever Nostr-level rules it
 * has (including NIP-42, which the publisher already handles).
 */
const RELAY_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * A drop-in `ws` WebSocket that always carries a browser User-Agent header.
 * Used both for the raw-WS publisher (`nostr-publisher.ts`) and as the
 * implementation injected into `nostr-tools`' pool via
 * `useWebSocketImplementation`, so the listener's `SimplePool` benefits too.
 */
export class RelayWebSocket extends WebSocket {
  constructor(address: string, protocols?: string | string[], options?: WebSocket.ClientOptions) {
    const merged: WebSocket.ClientOptions = {
      ...options,
      headers: {
        "User-Agent": RELAY_USER_AGENT,
        ...(options?.headers ?? {}),
      },
    };
    super(address, protocols, merged);
  }
}