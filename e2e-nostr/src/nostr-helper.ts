import WebSocket from "ws";
import { createRumor, createSeal } from "nostr-tools/nip59";
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { getConversationKey, encrypt } from "nostr-tools/nip44";
import type { Event, VerifiedEvent } from "nostr-tools/pure";

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

const GIFT_WRAP_KIND = 1059;
const MAIL_KIND = 1301;

/**
 * Wraps an RFC 2822 email string as a NIP-17 gift-wrapped kind 1301 event.
 *
 * Uses created_at = now() on the outer gift wrap so the bridge's `since`-filtered
 * subscription receives it reliably (NIP-59's createWrap normally randomises
 * created_at up to 2 days back, which strict relays would filter out).
 */
export function buildMailGiftWrap(
  rfc2822: string,
  senderPrivkey: Uint8Array,
  recipientPubkey: string,
  extraTags: string[][] = [],
): VerifiedEvent {
  const rumor = createRumor(
    { kind: MAIL_KIND, content: rfc2822, tags: [["p", recipientPubkey], ...extraTags] },
    senderPrivkey,
  );
  const seal = createSeal(rumor, senderPrivkey, recipientPubkey);
  const randomKey = generateSecretKey();
  return finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      content: encrypt(JSON.stringify(seal), getConversationKey(randomKey, recipientPubkey)),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", recipientPubkey]],
    },
    randomKey,
  );
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
