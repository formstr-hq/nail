import { randomUUID } from "node:crypto";
import { SimplePool } from "nostr-tools/pool";
import { unwrapEvent, createRumor, createSeal, createWrap } from "nostr-tools/nip59";
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { getConversationKey, encrypt } from "nostr-tools/nip44";
import { simpleParser } from "mailparser";
import type { Event, VerifiedEvent } from "nostr-tools/pure";
import { config } from "./config.js";
import { lookupNip05Pubkey } from "./nip05.js";
import { createPostfixTransport, injectIntoPostfix } from "./smtp-injector.js";
import { fetchAndDecryptAttachment } from "./blossom-client.js";
import { parseImetaTags } from "./attachment-utils.js";
export type { ImetaAttachment } from "./attachment-utils.js";
export { parseImetaTags } from "./attachment-utils.js";

const MAIL_KIND = 1301;
const GIFT_WRAP_KIND = 1059;
const HEARTBEAT_KIND = 1;
const HEARTBEAT_PREFIX = "nostr-bridge-heartbeat:";
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_MISSED_HEARTBEATS = 3;

async function getDmRelays(pool: SimplePool): Promise<string[]> {
  let events: Event[] = [];
  try {
    events = await pool.querySync(
      config.bootstrapRelays,
      { kinds: [10050], authors: [config.bridgePubkey] },
      { maxWait: 4000 },
    );
  } catch {
    // fall through to default
  }

  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) {
    console.log("nostr-bridge: no kind 10050 found for bridge pubkey, using bootstrap relays for DM listening");
    return config.bootstrapRelays;
  }

  const relays = latest.tags.filter((t) => t[0] === "relay" && t[1]).map((t) => t[1]);
  return relays.length > 0 ? relays : config.bootstrapRelays;
}

// Build a heartbeat gift wrap with created_at = now() so the relay's `since` filter
// doesn't discard it (NIP-59's createWrap normally randomises created_at up to 2 days back).
function buildHeartbeatWrap(id: string): VerifiedEvent {
  const rumor = createRumor(
    { kind: HEARTBEAT_KIND, content: `${HEARTBEAT_PREFIX}${id}`, tags: [] },
    config.bridgePrivkey,
  );
  const seal = createSeal(rumor, config.bridgePrivkey, config.bridgePubkey);
  const randomKey = generateSecretKey();
  return finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      content: encrypt(JSON.stringify(seal), getConversationKey(randomKey, config.bridgePubkey)),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", config.bridgePubkey]],
    },
    randomKey,
  );
}

export async function startNostrListener(
  postfixTransport: ReturnType<typeof createPostfixTransport>,
): Promise<void> {
  const pool = new SimplePool({ enableReconnect: true });
  const dmRelays = await getDmRelays(pool);

  console.log(`nostr-bridge: listening for mail/DMs on ${dmRelays.join(", ")}`);

  if (config.allowedDomains.length === 0) {
    console.warn(
      "nostr-bridge: ALLOWED_DOMAINS not set — all inbound mail accepted without NIP-05 verification",
    );
  } else {
    console.log(`nostr-bridge: NIP-05 verification enabled for domains: ${config.allowedDomains.join(", ")}`);
  }

  const seen = new Set<string>();
  const since = Math.floor(Date.now() / 1000);

  // --- heartbeat state ---
  let consecutiveMissed = 0;
  let pendingHeartbeatId: string | null = null;
  const confirmedHeartbeats = new Set<string>();

  async function sendVerificationError(
    senderPubkey: string,
    fromAddress: string,
    reason: string,
  ): Promise<void> {
    const date = new Date().toUTCString();
    const errorContent = [
      `From: noreply@${config.bridgeDomain}`,
      `To: bounce@${config.bridgeDomain}`,
      `Date: ${date}`,
      `Subject: Mail delivery failed: sender verification error`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Your message could not be delivered.`,
      ``,
      `Sender:  ${fromAddress}`,
      `Reason:  ${reason}`,
      ``,
      `Ensure your Nostr address (NIP-05) is correctly configured for ${fromAddress}.`,
    ].join("\r\n");

    try {
      const rumor = createRumor(
        { kind: MAIL_KIND, content: errorContent, tags: [["p", senderPubkey]] },
        config.bridgePrivkey,
      );
      const seal = createSeal(rumor, config.bridgePrivkey, senderPubkey);
      const wrap = createWrap(seal, senderPubkey);
      await Promise.allSettled(pool.publish(dmRelays, wrap as Event));
      console.log(`nostr-bridge: sent verification error to ${senderPubkey.slice(0, 8)}…`);
    } catch (err) {
      console.error("nostr-bridge: failed to send verification error:", (err as Error).message);
    }
  }

  // Dispatches a decrypted (or plain) inner event to the right handler.
  async function dispatch(kind: number, content: string, tags: string[][], senderPubkey: string): Promise<void> {
    if (kind === HEARTBEAT_KIND && content.startsWith(HEARTBEAT_PREFIX)) {
      const id = content.slice(HEARTBEAT_PREFIX.length);
      confirmedHeartbeats.add(id);
      console.log(`nostr-bridge: heartbeat confirmed (${id.slice(0, 8)}…)`);
      return;
    }
    if (kind === MAIL_KIND) {
      await sendMail(content, tags, postfixTransport, senderPubkey, sendVerificationError);
    }
  }

  // Single subscription for both encrypted gift wraps and plain kind 1301 events.
  pool.subscribeMany(
    dmRelays,
    { kinds: [GIFT_WRAP_KIND, MAIL_KIND], "#p": [config.bridgePubkey], since },
    {
      onevent: (event) => {
        if (seen.has(event.id)) return;
        if (seen.size >= 10_000) seen.clear();
        seen.add(event.id);

        if (event.kind === GIFT_WRAP_KIND) {
          let rumor;
          try {
            rumor = unwrapEvent(event as Parameters<typeof unwrapEvent>[0], config.bridgePrivkey);
          } catch {
            return;
          }
          void dispatch(rumor.kind, rumor.content, rumor.tags, rumor.pubkey);
        } else {
          // Unencrypted kind 1301 — process content directly.
          void dispatch(event.kind, event.content, event.tags, event.pubkey);
        }
      },
    },
  );

  // --- heartbeat: publish a NIP-59 self-DM each interval and verify it echoes back ---
  async function sendHeartbeat(): Promise<void> {
    if (pendingHeartbeatId !== null) {
      if (confirmedHeartbeats.delete(pendingHeartbeatId)) {
        consecutiveMissed = 0;
      } else {
        consecutiveMissed++;
        console.warn(`nostr-bridge: heartbeat not confirmed (${consecutiveMissed}/${MAX_MISSED_HEARTBEATS})`);
        if (consecutiveMissed >= MAX_MISSED_HEARTBEATS) {
          console.error("nostr-bridge: 3 consecutive heartbeats missed, shutting down for restart");
          process.exit(1);
        }
      }
    }

    const id = randomUUID();
    pendingHeartbeatId = id;

    try {
      const wrap = buildHeartbeatWrap(id);
      void Promise.allSettled(pool.publish(dmRelays, wrap as Event));
      console.log(`nostr-bridge: heartbeat sent (${id.slice(0, 8)}…)`);
    } catch (err) {
      console.error("nostr-bridge: failed to send heartbeat:", (err as Error).message);
    }
  }

  setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
}

export async function sendMail(
  content: string,
  tags: string[][],
  transport: ReturnType<typeof createPostfixTransport>,
  senderPubkey: string,
  notifyError: (senderPubkey: string, fromAddress: string, reason: string) => Promise<void>,
): Promise<void> {
  try {
    const parsed = await simpleParser(content);
    const toField = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    const toAddress = toField?.value[0]?.address;
    const fromAddress = parsed.from?.value[0]?.address ?? `bridge@${config.bridgeDomain}`;

    if (!toAddress) {
      console.error("nostr-bridge: kind 1301 missing To header, dropping");
      return;
    }

    if (config.allowedDomains.length > 0) {
      const atIdx = fromAddress.indexOf("@");
      const domain = atIdx > 0 ? fromAddress.slice(atIdx + 1) : "";

      if (!domain || !config.allowedDomains.includes(domain)) {
        console.warn(`nostr-bridge: rejected mail from ${fromAddress}: domain not in allowed list`);
        await notifyError(senderPubkey, fromAddress, `Domain "${domain || fromAddress}" is not permitted`);
        return;
      }

      const resolvedPubkey = await lookupNip05Pubkey(fromAddress);
      if (!resolvedPubkey) {
        console.warn(`nostr-bridge: rejected mail from ${fromAddress}: NIP-05 lookup failed`);
        await notifyError(senderPubkey, fromAddress, `NIP-05 verification failed for ${fromAddress}`);
        return;
      }

      if (resolvedPubkey !== senderPubkey) {
        console.warn(`nostr-bridge: rejected mail from ${fromAddress}: pubkey mismatch`);
        await notifyError(senderPubkey, fromAddress, `NIP-05 pubkey mismatch for ${fromAddress}`);
        return;
      }

      console.log(`nostr-bridge: NIP-05 verified ${fromAddress} → ${senderPubkey.slice(0, 8)}…`);
    }

    const imetaAttachments = parseImetaTags(tags);
    if (imetaAttachments.length === 0) {
      await injectIntoPostfix(transport, {
        envelope: { from: fromAddress, to: toAddress },
        raw: content,
      });
      console.log(`nostr-bridge: injected mail from ${fromAddress} to ${toAddress}`);
      return;
    }

    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
    for (const meta of imetaAttachments) {
      try {
        let data: Buffer;
        if (meta.encryptionKey !== undefined && meta.decryptionNonce !== undefined) {
          data = await fetchAndDecryptAttachment(meta.url, meta.encryptionKey, meta.decryptionNonce);
        } else {
          const res = await fetch(meta.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = Buffer.from(await res.arrayBuffer());
        }
        attachments.push({ filename: meta.filename, content: data, contentType: meta.mimeType });
      } catch (err) {
        console.error(`nostr-bridge: failed to fetch attachment "${meta.filename}":`, (err as Error).message);
      }
    }

    await injectIntoPostfix(transport, {
      envelope: { from: fromAddress, to: toAddress },
      from: fromAddress,
      to: toAddress,
      subject: parsed.subject,
      text: parsed.text ?? undefined,
      html: parsed.html !== false ? parsed.html : undefined,
      attachments,
    });
    console.log(
      `nostr-bridge: injected mail from ${fromAddress} to ${toAddress} with ${attachments.length}/${imetaAttachments.length} attachment(s)`,
    );
  } catch (err) {
    console.error("nostr-bridge: failed to inject mail:", (err as Error).message);
  }
}
