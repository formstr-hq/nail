#!/usr/bin/env tsx
/**
 * Send a regular SMTP email to an address and wait for the resulting Nostr DM.
 * Tests the full inbound pipeline: SMTP → bridge → Nostr relay → DM.
 *
 * Usage:
 *   RECIPIENT_EMAIL=user@mailstr.app \
 *   RECIPIENT_NSEC=nsec1… \
 *   SMTP_HOST=mail.mailstr.app \
 *   RELAY_URL=wss://relay.damus.io \
 *   tsx scripts/send-and-listen.ts
 *
 * Optional:
 *   FROM_EMAIL=you@example.com   (default: test@<SMTP_HOST>)
 *   SMTP_PORT=25                 (default: 25)
 *   SMTP_USER / SMTP_PASS        (omit for unauthenticated SMTP)
 *   SUBJECT / BODY
 *   TIMEOUT_MS=30000             (default: 30 s)
 */

import nodemailer from "nodemailer";
import WebSocket from "ws";
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { unwrapEvent } from "nostr-tools/nip59";
import type { Event } from "nostr-tools/pure";

// --- config ---
const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL;
const RECIPIENT_NSEC = process.env.RECIPIENT_NSEC;
const SMTP_HOST = process.env.SMTP_HOST ?? "localhost";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 25);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const RELAY_URL = process.env.RELAY_URL ?? "wss://relay.damus.io";
const FROM_EMAIL = process.env.FROM_EMAIL ?? `test@${SMTP_HOST}`;
const SUBJECT =
  process.env.SUBJECT ?? `Bridge test ${new Date().toISOString()}`;
const BODY = process.env.BODY ?? `Sent at ${new Date().toISOString()}`;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30_000);

if (!RECIPIENT_EMAIL || !RECIPIENT_NSEC) {
  console.error("Required: RECIPIENT_EMAIL and RECIPIENT_NSEC");
  process.exit(1);
}

// --- subscribe first, send second, so no race ---
function subscribeForDM(
  relayUrl: string,
  recipientPubkey: string,
  recipientPrivkey: Uint8Array,
  timeoutMs: number,
): Promise<{ kind: number; content: string; tags: string[][] }> {
  return new Promise((resolve, reject) => {
    const since = Math.floor((Date.now() - 1000 * 60 * 15) / 1000);
    const ws = new WebSocket(relayUrl);

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout: no DM arrived after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(
        JSON.stringify([
          "REQ",
          "dm-listen",
          { kinds: [1059], "#p": [recipientPubkey] },
        ]),
      );
    });

    ws.on("message", (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(raw.toString()) as unknown[];
      } catch {
        return;
      }
      if (msg[0] !== "EVENT") return;

      const event = msg[2] as Event;
      if (event?.kind !== 1059) return;

      try {
        const rumor = unwrapEvent(
          event as Parameters<typeof unwrapEvent>[0],
          recipientPrivkey,
        );
        clearTimeout(timer);
        ws.close();
        resolve({ kind: rumor.kind, content: rumor.content, tags: rumor.tags });
      } catch {
        // not for us or malformed — keep waiting
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// async function sendEmail(): Promise<void> {
//   const transport = nodemailer.createTransport({
//     host: SMTP_HOST,
//     port: SMTP_PORT,
//     secure: SMTP_PORT === 465,
//     ...(SMTP_USER && SMTP_PASS
//       ? { auth: { user: SMTP_USER, pass: SMTP_PASS }, requireTLS: SMTP_PORT === 587 }
//       : { ignoreTLS: true }),
//     tls: { rejectUnauthorized: false },
//   });

//   await transport.sendMail({ from: FROM_EMAIL, to: RECIPIENT_EMAIL!, subject: SUBJECT, text: BODY });
//   console.log(`Sent  : ${FROM_EMAIL} → ${RECIPIENT_EMAIL} via ${SMTP_HOST}:${SMTP_PORT}`);
// }

async function main(): Promise<void> {
  const decoded = decode(RECIPIENT_NSEC!);
  if (decoded.type !== "nsec")
    throw new Error("RECIPIENT_NSEC is not a valid nsec");
  const recipientPrivkey = decoded.data;
  const recipientPubkey = getPublicKey(recipientPrivkey);
  console.log(`Pubkey: ${recipientPubkey}`);
  console.log(`Relay : ${RELAY_URL}`);

  // Subscribe before sending so we don't miss the event.
  const dmPromise = subscribeForDM(
    RELAY_URL,
    recipientPubkey,
    recipientPrivkey,
    TIMEOUT_MS,
  );

  // await sendEmail();
  console.log(`Waiting up to ${TIMEOUT_MS / 1000}s for DM …\n`);

  const rumor = await dmPromise;

  console.log("--- DM received ---");
  console.log(`Kind    : ${rumor.kind}`);
  console.log(`Content :\n${rumor.content}`);
}

main().catch((err) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
