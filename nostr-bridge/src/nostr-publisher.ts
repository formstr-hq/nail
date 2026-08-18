import WebSocket from "ws";
import type { Event } from "nostr-tools";
import { buildMailRumor, sealAndWrap } from "./protocol/mail.js";
import type { ProtocolSigner } from "./protocol/types.js";
import { KIND_CLIENT_AUTH } from "./protocol/constants.js";

/** A relay declining a write until we authenticate (NIP-42). */
function isAuthRequired(reason: unknown): boolean {
  return typeof reason === "string" && /^(auth-required|restricted)/i.test(reason);
}

/**
 * Publish one event to one relay, resolving true only on an explicit
 * `["OK", id, true]`.
 *
 * If the relay demands NIP-42 auth — either by pushing an `["AUTH", challenge]`
 * frame or rejecting the EVENT with an `auth-required` reason — the bridge signs
 * a kind-22242 event with its own key, sends `["AUTH", ...]`, and resends the
 * mail event once. A relay that never accepts falls through to the timeout.
 */
// Exported for testing against a stubbed relay, the same pattern the listener
// uses for handleWrap. Callers should go through publishMail.
export function publishToRelay(
  relayUrl: string,
  event: Event,
  signer: ProtocolSigner,
  timeoutMs = 4000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let challenge: string | null = null;
    let authEventId: string | null = null;
    let authAttempted = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };

    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => finish(false), timeoutMs);

    const sendEvent = () => ws.send(JSON.stringify(["EVENT", event]));

    // Only ever authenticate once per connection: relays that keep rejecting
    // after a valid AUTH are refusing us for some other reason, and retrying
    // would just spin until the timeout.
    const authenticate = async () => {
      if (authAttempted || challenge === null) return;
      authAttempted = true;
      try {
        const authEvent = await signer.signEvent({
          kind: KIND_CLIENT_AUTH,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          content: "",
          pubkey: await signer.getPublicKey(),
        });
        authEventId = authEvent.id;
        ws.send(JSON.stringify(["AUTH", authEvent]));
      } catch (error) {
        console.error(`nostr-bridge: relay ${relayUrl} auth failed:`, (error as Error).message);
        finish(false);
      }
    };

    ws.on("open", () => sendEvent());
    ws.on("message", (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed relay frames
      }
      if (!Array.isArray(data)) return;

      if (data[0] === "AUTH" && typeof data[1] === "string") {
        challenge = data[1];
        void authenticate();
        return;
      }

      if (data[0] === "OK") {
        const [, id, ok, reason] = data as [string, string, boolean, string?];
        if (id === event.id) {
          if (ok) finish(true);
          // Auth challenges arrive in a separate AUTH frame; if we have one and
          // have not used it yet, authenticate and let the resend settle this.
          else if (isAuthRequired(reason) && !authAttempted) void authenticate();
          else if (!isAuthRequired(reason)) finish(false);
          // else: auth in flight — wait for the resend result or the timeout.
        } else if (id === authEventId) {
          if (ok) sendEvent(); // authenticated: resend the mail event once
          else finish(false);
        }
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
  const relays = [...new Set(params.relays)];
  const results = await Promise.all(
    relays.map((relay) => publishToRelay(relay, wrap, params.signer)),
  );
  return results.some(Boolean);
}
