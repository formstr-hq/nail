import WebSocket from "ws";
import type { Event } from "nostr-tools/pure";

/**
 * Opens a WebSocket subscription on the relay and resolves with the first
 * kind-1059 gift wrap tagged with recipientPubkey.  Works with any relay URL —
 * in-process nostr-mock-relay or a remote container.
 */
export function waitForGiftWrap(
  relayUrl: string,
  recipientPubkey: string,
  timeoutMs: number,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout: no gift-wrapped DM arrived on relay"));
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(
        JSON.stringify(["REQ", "sub-inbound", { kinds: [1059], "#p": [recipientPubkey] }]),
      );
    });

    ws.on("message", (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(raw.toString()) as unknown[];
      } catch {
        return;
      }
      if (msg[0] === "EVENT") {
        const event = msg[2] as Event;
        if (event?.kind === 1059) {
          clearTimeout(timer);
          ws.close();
          resolve(event);
        }
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Publishes a single event to a relay and resolves true when the relay ACKs it. */
export function publishToRelay(relayUrl: string, event: Event, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };

    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => finish(false), timeoutMs);

    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as unknown[];
        if (data[0] === "OK" && data[1] === event.id) finish(Boolean(data[2]));
      } catch {
        // ignore malformed relay messages
      }
    });
    ws.on("error", () => finish(false));
  });
}
