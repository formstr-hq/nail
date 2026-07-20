import { randomUUID } from "node:crypto";
import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools";
import { config } from "./config.js";
import { keySigner } from "./protocol/key-signer.js";
import { unwrapAndVerify, deliverTargets, buildMailRumor, sealAndWrap } from "./protocol/mail.js";
import { messageStringToBytes } from "./protocol/bytes.js";
import { KIND_GIFTWRAP, MAX_RUMOR_AGE_SECONDS } from "./protocol/constants.js";
import { authorizeSender, selectDeliverTargets } from "./outbound.js";
import { createPostfixTransport, injectIntoPostfix } from "./smtp-injector.js";

const bridgeSigner = keySigner(config.bridgePrivkey);

/**
 * NIP-59 randomises a gift wrap's created_at up to two days into the past so
 * timing analysis fails. Relays filter on that outer timestamp, so a `since`
 * of "now" would make them withhold essentially every wrap addressed to us.
 * Look back past the whole randomisation window instead; the replay guard
 * below still bounds acceptance by the rumor's true timestamp.
 */
const WRAP_LOOKBACK_SECONDS = 2 * 24 * 60 * 60 + 3600;

const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_MISSED_HEARTBEATS = 3;

/** Bounded set of rumor ids already processed — the replay guard's fast path. */
const processed = new Set<string>();
const PROCESSED_MAX = 50_000;

/** Heartbeat ids this process has seen echo back off the relays. */
const confirmedHeartbeats = new Set<string>();

function remember(id: string): boolean {
  if (processed.has(id)) return false;
  if (processed.size >= PROCESSED_MAX) processed.clear();
  processed.add(id);
  return true;
}

async function sendBounce(
  pool: SimplePool,
  relays: string[],
  recipientPubkey: string,
  reason: string,
): Promise<void> {
  const body = [
    `From: postmaster@${config.localDomains[0]}`,
    `To: <${recipientPubkey}>`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: Mail delivery failed`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Your message could not be delivered.`,
    ``,
    `Reason: ${reason}`,
  ].join("\r\n");

  try {
    const rumor = buildMailRumor({
      senderPubkey: await bridgeSigner.getPublicKey(),
      recipientPubkey,
      rfc2822: body,
    });
    const wrap = await sealAndWrap(rumor, recipientPubkey, bridgeSigner);
    await Promise.allSettled(pool.publish(relays, wrap));
  } catch (err) {
    console.error("nostr-bridge: failed to send bounce:", (err as Error).message);
  }
}

// Exported (module scope, not a closure) so it can be tested directly against
// a stubbed pool/transport, the same pattern lmtp-server.ts uses for
// handleMessage.
export async function handleWrap(
  pool: SimplePool,
  relays: string[],
  transport: ReturnType<typeof createPostfixTransport>,
  event: Event,
): Promise<void> {
  const result = await unwrapAndVerify(event, bridgeSigner, {
    maxAgeSeconds: MAX_RUMOR_AGE_SECONDS,
  });

  if (!result.ok) {
    // "not-for-us" is routine — relays hand us every wrap p-tagged to us.
    // Everything else means something is broken or hostile: log it (§8).
    if (result.reason !== "not-for-us") {
      console.warn(`nostr-bridge: rejected wrap ${event.id.slice(0, 8)}: ${result.reason}`);
    }
    return;
  }

  const { seal, rumor } = result;

  // A heartbeat we published to ourselves, echoed back off the relays. Consume
  // it before authorization: it is a liveness probe, not mail. Requiring the
  // bridge's own key to have sealed it stops anyone else from forging one and
  // keeping a dead bridge looking alive.
  const heartbeat = rumor.tags.find((t) => t[0] === "heartbeat" && t[1])?.[1];
  if (heartbeat && seal.pubkey === config.bridgePubkey) {
    confirmedHeartbeats.add(heartbeat);
    return;
  }

  if (!remember(rumor.id)) {
    console.warn(`nostr-bridge: duplicate rumor ${rumor.id.slice(0, 8)}, dropping`);
    return;
  }

  const fromMatch = /^From:\s*(.*)$/im.exec(rumor.content);
  const fromHeader = fromMatch?.[1]?.trim() ?? "";
  const angle = /<([^>]+)>/.exec(fromHeader);
  const fromAddress = (angle?.[1] ?? fromHeader).trim();

  const auth = await authorizeSender({
    from: fromAddress,
    sealPubkey: seal.pubkey,
    localDomains: config.localDomains,
    nip05BaseUrl: config.nip05BaseUrl,
  });

  if (!auth.ok) {
    console.warn(`nostr-bridge: unauthorized send from ${seal.pubkey.slice(0, 8)}: ${auth.reason}`);
    await sendBounce(pool, relays, seal.pubkey, auth.reason);
    return;
  }

  const { deliver, rejected } = selectDeliverTargets(
    deliverTargets(rumor),
    config.localDomains,
  );

  if (rejected.length) {
    console.warn(`nostr-bridge: refused deliver targets: ${rejected.join(", ")}`);
  }
  if (deliver.length === 0) {
    console.warn(`nostr-bridge: rumor ${rumor.id.slice(0, 8)} has no deliverable targets`);
    await sendBounce(pool, relays, seal.pubkey, "No deliverable recipients");
    return;
  }

  try {
    // One message, N envelope recipients. Routing comes from the deliver
    // tags, never from the To: header — the header is what recipients see,
    // the envelope is who this hop delivers to (§4).
    //
    // rumor.content is the byte-string form (§4 "Content is a byte string"):
    // convert back to real bytes here, at the outbound boundary, rather than
    // handing nodemailer the byte string directly — nodemailer would encode
    // a string `raw` as UTF-8 and corrupt any non-UTF-8 message.
    await injectIntoPostfix(transport, {
      envelope: { from: auth.address, to: deliver },
      raw: Buffer.from(messageStringToBytes(rumor.content)),
    });
    console.log(`nostr-bridge: relayed from ${auth.address} to ${deliver.join(", ")}`);
  } catch (err) {
    console.error("nostr-bridge: Postfix injection failed:", (err as Error).message);
    await sendBounce(pool, relays, seal.pubkey, "Downstream mail server unavailable");
  }
}

/**
 * Publish a gift wrap to ourselves and check that the previous one came back.
 *
 * A relay subscription can die silently — the socket stays open, no error is
 * raised, and no events ever arrive again. For a mail bridge that failure is
 * invisible: it looks perfectly healthy while accepting no outbound mail at
 * all. Exiting lets the supervisor (`restart: unless-stopped`) restart us.
 *
 * The probe deliberately travels the full seal/wrap/relay/unwrap path rather
 * than pinging the socket, so it also catches a broken crypto or relay-accept
 * path, not just a dead connection.
 */
export function startHeartbeat(pool: SimplePool, relays: string[]): NodeJS.Timeout {
  let pending: string | null = null;
  let missed = 0;

  return setInterval(() => {
    void (async () => {
      if (pending !== null) {
        if (confirmedHeartbeats.delete(pending)) {
          missed = 0;
        } else {
          missed += 1;
          console.warn(`nostr-bridge: heartbeat unconfirmed (${missed}/${MAX_MISSED_HEARTBEATS})`);
          if (missed >= MAX_MISSED_HEARTBEATS) {
            console.error("nostr-bridge: relay subscription appears dead, exiting for restart");
            process.exit(1);
          }
        }
      }

      const id = randomUUID();
      pending = id;

      try {
        const pubkey = await bridgeSigner.getPublicKey();
        const rumor = buildMailRumor({
          senderPubkey: pubkey,
          recipientPubkey: pubkey,
          rfc2822: `Subject: heartbeat\r\n\r\n${id}`,
        });
        rumor.tags.push(["heartbeat", id]);
        const wrap = await sealAndWrap(rumor, pubkey, bridgeSigner);
        void Promise.allSettled(pool.publish(relays, wrap));
      } catch (err) {
        console.error("nostr-bridge: failed to send heartbeat:", (err as Error).message);
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
}

export async function startNostrListener(
  transport: ReturnType<typeof createPostfixTransport>,
): Promise<void> {
  const pool = new SimplePool({ enableReconnect: true });
  const relays = config.bridgeRelays;

  console.log(`nostr-bridge: listening on ${relays.join(", ")}`);
  console.log(`nostr-bridge: serving domains ${config.localDomains.join(", ")}`);

  pool.subscribeMany(
    relays,
    {
      kinds: [KIND_GIFTWRAP],
      "#p": [config.bridgePubkey],
      since: Math.floor(Date.now() / 1000) - WRAP_LOOKBACK_SECONDS,
    },
    {
      onevent: (event) => void handleWrap(pool, relays, transport, event),
    },
  );

  startHeartbeat(pool, relays);
}
