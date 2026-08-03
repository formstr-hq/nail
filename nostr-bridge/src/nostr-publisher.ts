import WebSocket from "ws";
import type { Event } from "nostr-tools";
import { buildMailRumor, sealAndWrap } from "./protocol/mail.js";
import type { ProtocolSigner } from "./protocol/types.js";

function publishToRelay(relayUrl: string, event: Event, timeoutMs = 4000): Promise<boolean> {
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
        const data = JSON.parse(raw.toString());
        if (data[0] === "OK" && data[1] === event.id) finish(Boolean(data[2]));
      } catch {
        // ignore malformed relay frames
      }
    });
    ws.on("error", (error) => {
      console.error(`nostr-bridge: relay ${relayUrl} error:`, (error as Error).message);
      finish(false);
    });
  });
}

/**
 * Wrap an inbound email for a recipient. The rumor content is the ORIGINAL
 * message, unmodified — headers are the identity and threading model (§1), so
 * reconstructing the message from parsed fields destroys both.
 */
export async function buildInboundWrap(
  raw: string,
  recipientPubkey: string,
  signer: ProtocolSigner,
): Promise<Event> {
  const rumor = buildMailRumor({
    senderPubkey: await signer.getPublicKey(),
    recipientPubkey,
    rfc2822: raw,
  });
  return sealAndWrap(rumor, recipientPubkey, signer);
}

/** Returns true if at least one relay accepted the event. */
export async function publishMail(params: {
  raw: string;
  recipientPubkey: string;
  signer: ProtocolSigner;
  relays: string[];
}): Promise<boolean> {
  const wrap = await buildInboundWrap(params.raw, params.recipientPubkey, params.signer);
  const results = await Promise.all(
    params.relays.map((relay) => publishToRelay(relay, wrap)),
  );
  return results.some(Boolean);
}
