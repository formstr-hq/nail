import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import type { Event } from "nostr-tools";
import { keySigner } from "./protocol/key-signer.js";
import { KIND_CLIENT_AUTH } from "./protocol/constants.js";
import { publishToRelay } from "./nostr-publisher.js";

const bridgeSk = generateSecretKey();
const bridgePk = getPublicKey(bridgeSk);
const signer = keySigner(bridgeSk);

function sampleEvent(): Event {
  return finalizeEvent({ kind: 1059, created_at: 1, tags: [], content: "wrap" }, generateSecretKey());
}

type Handler = (ws: WsClient, msg: unknown[]) => void;

let server: WebSocketServer | null = null;
function startRelay(handler: Handler): Promise<string> {
  return new Promise((resolve) => {
    server = new WebSocketServer({ port: 0 }, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`ws://127.0.0.1:${port}`);
    });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        let msg: unknown[];
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        handler(ws as unknown as WsClient, msg);
      });
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

describe("publishToRelay NIP-42", () => {
  it("resolves true on a plain OK, without authenticating", async () => {
    let sawAuth = false;
    const url = await startRelay((ws, msg) => {
      if (msg[0] === "AUTH") sawAuth = true;
      if (msg[0] === "EVENT") ws.send(JSON.stringify(["OK", (msg[1] as Event).id, true, ""]));
    });

    const event = sampleEvent();
    await expect(publishToRelay(url, event, signer, 2000)).resolves.toBe(true);
    expect(sawAuth).toBe(false);
  });

  it("authenticates with the bridge key when the relay demands it, then delivers", async () => {
    const challenge = "chal-123";
    let authEvent: Event | null = null;

    const url = await startRelay((ws, msg) => {
      if (msg[0] === "EVENT") {
        const ev = msg[1] as Event;
        // Reject the mail event until we have seen a valid AUTH.
        if (!authEvent) ws.send(JSON.stringify(["OK", ev.id, false, "auth-required: take a challenge"]));
        else ws.send(JSON.stringify(["OK", ev.id, true, ""]));
      } else if (msg[0] === "AUTH") {
        authEvent = msg[1] as Event;
        ws.send(JSON.stringify(["OK", authEvent.id, true, ""]));
      }
    });

    // Relay pushes the challenge on connect (the common pattern).
    server!.on("connection", (ws) => ws.send(JSON.stringify(["AUTH", challenge])));

    const event = sampleEvent();
    await expect(publishToRelay(url, event, signer, 3000)).resolves.toBe(true);

    expect(authEvent).not.toBeNull();
    expect(authEvent!.kind).toBe(KIND_CLIENT_AUTH);
    expect(authEvent!.pubkey).toBe(bridgePk);
    expect(verifyEvent(authEvent!)).toBe(true);
    expect(authEvent!.tags).toContainEqual(["relay", url]);
    expect(authEvent!.tags).toContainEqual(["challenge", challenge]);
  });

  it("resolves false on a non-auth rejection", async () => {
    const url = await startRelay((ws, msg) => {
      if (msg[0] === "EVENT") ws.send(JSON.stringify(["OK", (msg[1] as Event).id, false, "blocked: spam"]));
    });
    await expect(publishToRelay(url, sampleEvent(), signer, 2000)).resolves.toBe(false);
  });
});
