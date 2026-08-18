#!/usr/bin/env tsx
/**
 * Send a test kind-1301 mail to the Nostr bridge.
 *
 * The bridge pubkey is discovered via NIP-05 (_smtp@<BRIDGE_DOMAIN>).
 *
 * Usage:
 *   BRIDGE_DOMAIN=mailstr.app \
 *   FROM=alice@mailstr.app \
 *   TO=bob@example.com \
 *   tsx scripts/send-test-mail.ts
 *
 * Optional env vars:
 *   RELAY_URL=wss://relay.damus.io   (default: wss://relay.<BRIDGE_DOMAIN>)
 *   SUBJECT="Hello"                  (default: "Test mail")
 *   BODY="World"                     (default: current ISO timestamp)
 *   SENDER_NSEC=nsec1…               (default: random ephemeral key)
 */

import { createRumor, createSeal } from "nostr-tools/nip59";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from "nostr-tools/pure";
import { getConversationKey, encrypt } from "nostr-tools/nip44";
import { decode } from "nostr-tools/nip19";
import WebSocket from "ws";

const GIFT_WRAP_KIND = 1059;
const MAIL_KIND = 1301;

// --- config ---
const BRIDGE_DOMAIN = process.env.BRIDGE_DOMAIN ?? "mailstr.app";
const RELAY_URL = process.env.RELAY_URL ?? `wss://relay.damus.io`;
const FROM = process.env.FROM ?? `_test@${BRIDGE_DOMAIN}`;
const TO = process.env.TO;
const SUBJECT = process.env.SUBJECT ?? "This has been sent using the bridge";
const BODY = process.env.BODY ?? `Sent at ${new Date().toISOString()}`;

if (!TO) {
  console.error("Error: set the TO env var to the recipient email address");
  process.exit(1);
}

// --- NIP-05 bridge discovery ---
async function resolveBridgePubkey(domain: string): Promise<string> {
  const url = `https://${domain}/.well-known/nostr.json?name=_smtp`;
  console.log(`Resolving bridge pubkey from ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`NIP-05 fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { names?: Record<string, string> };
  const pubkey = body.names?.["_smtp"];
  if (!pubkey) throw new Error(`No _smtp entry in nostr.json for ${domain}`);
  return pubkey;
}

// --- helpers ---
function buildRfc2822(
  from: string,
  to: string,
  subject: string,
  body: string,
): string {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join("\r\n");
}

function publish(
  relayUrl: string,
  event: { id: string },
  timeoutMs = 8000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      resolve(ok);
    };
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as unknown[];
        if (msg[0] === "OK" && msg[1] === event.id) finish(Boolean(msg[2]));
      } catch {
        /* ignore */
      }
    });
    ws.on("error", () => finish(false));
  });
}

// --- main ---
async function main(): Promise<void> {
  let senderPrivkey: Uint8Array;
  if (process.env.SENDER_NSEC) {
    const decoded = decode(process.env.SENDER_NSEC);
    if (decoded.type !== "nsec")
      throw new Error("SENDER_NSEC is not a valid nsec");
    senderPrivkey = decoded.data;
    console.log("Using provided SENDER_NSEC");
  } else {
    senderPrivkey = generateSecretKey();
    console.log("Using ephemeral sender key (set SENDER_NSEC to reuse a key)");
  }
  const senderPubkey = getPublicKey(senderPrivkey);
  console.log(`Sender pubkey : ${senderPubkey}`);

  const bridgePubkey = await resolveBridgePubkey(BRIDGE_DOMAIN);
  console.log(`Bridge pubkey : ${bridgePubkey}`);

  const content = buildRfc2822(FROM, TO!, SUBJECT, BODY);

  const rumor = createRumor(
    { kind: MAIL_KIND, content, tags: [["p", bridgePubkey]] },
    senderPrivkey,
  );
  const seal = createSeal(rumor, senderPrivkey, bridgePubkey);

  // Use created_at = now() on the outer wrap so the bridge's `since` filter
  // doesn't discard it (NIP-59's createWrap randomises created_at up to 2 days back).
  const wrapKey = generateSecretKey();
  const wrap = finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      content: encrypt(
        JSON.stringify(seal),
        getConversationKey(wrapKey, bridgePubkey),
      ),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", bridgePubkey]],
    },
    wrapKey,
  );

  console.log(`\nPublishing to ${RELAY_URL} …`);
  const ok = await publish(RELAY_URL, wrap);
  if (!ok) throw new Error("Relay rejected the event");
  console.log(`Done — event id: ${wrap.id}`);
}

main().catch((err) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
