import { randomUUID } from "node:crypto";
import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools";
import { config } from "./config.js";
import { keySigner } from "./protocol/key-signer.js";
import { unwrapAndVerify, deliverTargets, buildMailRumor, buildRumor, sealAndWrap } from "./protocol/mail.js";
import { messageStringToBytes } from "./protocol/bytes.js";
import {
  KIND_GIFTWRAP,
  KIND_GIFTWRAP_EPHEMERAL,
  KIND_DELIVERY_RECEIPT,
  KIND_HEALTH_PING,
  KIND_MAIL,
  MAX_RUMOR_AGE_SECONDS,
} from "./protocol/constants.js";
import { authorizeSender, selectDeliverTargets } from "./outbound.js";
import { createPostfixTransport, injectIntoPostfix } from "./smtp-injector.js";

const bridgeSigner = keySigner(config.bridgePrivkey);

/**
 * Outstanding health-ping self-tests, keyed by nonce. `runSelfTest` publishes a
 * gift wrap addressed to the bridge itself and parks a resolver here; when that
 * wrap comes back through the live subscription, `handleWrap` resolves it. A
 * timeout removes the entry and the self-test fails.
 */
const pendingPings = new Map<string, () => void>();

// Last moment the receive path was proven healthy (a self-test round-tripped).
// Seeded at startup so /healthz reports healthy through the start-up grace
// window before the first self-test runs.
let lastHealthyAt = Date.now();

/** Snapshot for the /healthz endpoint (see health-server.ts). */
export function healthSnapshot(): { lastHealthyAt: number; healthy: boolean } {
  const staleAfter = config.healthIntervalMs + config.healthTimeoutMs;
  return { lastHealthyAt, healthy: Date.now() - lastHealthyAt < staleAfter };
}

/**
 * Delivery receipt: once mail is handed to Postfix, tell the sender so their
 * client can show it as delivered. Sent as an EPHEMERAL gift wrap — relays
 * broadcast it to the sender's live subscription but never persist it, which is
 * exactly right for a transient, best-effort confirmation. Mirrors sendBounce.
 */
async function sendDeliveryReceipt(
  pool: SimplePool,
  relays: string[],
  recipientPubkey: string,
  messageId: string | undefined,
  deliveredTo: string[],
): Promise<void> {
  try {
    const rumor = buildRumor({
      senderPubkey: config.bridgePubkey,
      recipientPubkey,
      kind: KIND_DELIVERY_RECEIPT,
      content: JSON.stringify({ v: 1, messageId, deliveredTo }),
    });
    const wrap = await sealAndWrap(rumor, recipientPubkey, bridgeSigner, {
      wrapKind: KIND_GIFTWRAP_EPHEMERAL,
    });
    const results = await Promise.allSettled(pool.publish(relays, wrap));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    console.log(
      `nostr-bridge: delivery receipt ${messageId ?? "(no message-id)"} → ${recipientPubkey.slice(0, 8)} (${ok}/${results.length} relays)`,
    );
  } catch (err) {
    console.error("nostr-bridge: failed to send delivery receipt:", (err as Error).message);
  }
}

/**
 * NIP-59 randomises a gift wrap's created_at up to two days into the past so
 * timing analysis fails. Relays filter on that outer timestamp, so a `since`
 * of "now" would make them withhold essentially every wrap addressed to us.
 * Look back past the whole randomisation window instead; the replay guard
 * below still bounds acceptance by the rumor's true timestamp.
 */
const WRAP_LOOKBACK_SECONDS = 2 * 24 * 60 * 60 + 3600;


/** Bounded set of rumor ids already processed — the replay guard's fast path. */
const processed = new Set<string>();
const PROCESSED_MAX = 50_000;

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
    const results = await Promise.allSettled(pool.publish(relays, wrap));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    console.log(
      `nostr-bridge: bounce → ${recipientPubkey.slice(0, 8)} (${ok}/${results.length} relays): ${reason}`,
    );
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
    // Mail is the point; the health-ping loopback is the only other inner kind
    // we accept, and only from ourselves (checked below).
    acceptKinds: [KIND_MAIL, KIND_HEALTH_PING],
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

  // Health-ping loopback: our own self-test wrap has come back through the live
  // subscription, proving the receive path works. Resolve the waiting self-test
  // and stop — it is never mail and must not be injected or replay-guarded.
  if (rumor.kind === KIND_HEALTH_PING) {
    if (seal.pubkey === config.bridgePubkey) {
      const nonce = rumor.tags.find((t) => t[0] === "nonce")?.[1];
      const resolve = nonce ? pendingPings.get(nonce) : undefined;
      if (resolve) {
        pendingPings.delete(nonce!);
        resolve();
      }
    }
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

    // The mail is now Postfix's problem — tell the sender it left the bridge, so
    // their client can mark it delivered. `Message-ID` correlates the receipt to
    // the sender's Sent copy; both are built from the one RFC 2822 message.
    const midMatch = /^Message-ID:\s*(.*)$/im.exec(rumor.content);
    const messageId = midMatch?.[1]?.trim() || undefined;
    void sendDeliveryReceipt(pool, relays, seal.pubkey, messageId, deliver);
  } catch (err) {
    console.error("nostr-bridge: Postfix injection failed:", (err as Error).message);
    await sendBounce(pool, relays, seal.pubkey, "Downstream mail server unavailable");
  }
}

/**
 * One loopback self-test: seal an ephemeral health-ping to ourselves, publish
 * it, and wait for it to come back through the live subscription within the
 * timeout. A `true` result proves the *entire* receive path — sockets, relay
 * acceptance, subscription delivery, unwrap — still works end to end. A `false`
 * means the bridge can no longer receive gift wraps, which is invisible to a
 * plain TCP health check.
 */
async function runSelfTest(pool: SimplePool, relays: string[]): Promise<boolean> {
  const nonce = randomUUID();
  const rumor = buildRumor({
    senderPubkey: config.bridgePubkey,
    recipientPubkey: config.bridgePubkey,
    kind: KIND_HEALTH_PING,
    content: "",
    extraTags: [["nonce", nonce]],
  });
  const wrap = await sealAndWrap(rumor, config.bridgePubkey, bridgeSigner, {
    wrapKind: KIND_GIFTWRAP_EPHEMERAL,
  });

  const roundTrip = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingPings.delete(nonce);
      resolve(false);
    }, config.healthTimeoutMs);
    pendingPings.set(nonce, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  await Promise.allSettled(pool.publish(relays, wrap));
  return roundTrip;
}

/**
 * Watchdog. Runs a self-test after a start-up grace period, then on a fixed
 * interval. On failure it exits non-zero rather than trying to limp on: Docker's
 * `restart: unless-stopped` brings the process back with fresh relay sockets,
 * which is the only reliable recovery when SimplePool's own reconnect hasn't
 * restored delivery. Success stamps `lastHealthyAt` for /healthz.
 */
function startWatchdog(pool: SimplePool, relays: string[]): void {
  const tick = async () => {
    let ok = false;
    try {
      ok = await runSelfTest(pool, relays);
    } catch (err) {
      console.error("nostr-bridge: self-test threw:", (err as Error).message);
    }
    if (ok) {
      lastHealthyAt = Date.now();
      console.log("nostr-bridge: self-test OK — receive path healthy");
      return;
    }
    console.error(
      "nostr-bridge: SELF-TEST FAILED — no gift wrap received back within " +
        `${config.healthTimeoutMs}ms; receive path is dead, restarting`,
    );
    process.exit(1);
  };

  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), config.healthIntervalMs);
  }, config.healthStartupDelayMs);
}

export async function startNostrListener(
  transport: ReturnType<typeof createPostfixTransport>,
): Promise<void> {
  const pool = new SimplePool({ enableReconnect: true });
  const relays = config.bridgeRelays;

  console.log(`nostr-bridge: listening on ${relays.join(", ")}`);
  console.log(`nostr-bridge: serving domains ${config.localDomains.join(", ")}`);

  const since = Math.floor(Date.now() / 1000) - WRAP_LOOKBACK_SECONDS;
  console.log(`nostr-bridge: subscribing #p=${config.bridgePubkey.slice(0, 8)} since ${since}`);

  pool.subscribeMany(
    relays,
    {
      // KIND_GIFTWRAP is real mail; KIND_GIFTWRAP_EPHEMERAL carries the
      // health-ping loopback the self-test publishes to ourselves.
      kinds: [KIND_GIFTWRAP, KIND_GIFTWRAP_EPHEMERAL],
      "#p": [config.bridgePubkey],
      since,
    },
    {
      onevent: (event) => {
        console.log(
          `nostr-bridge: received wrap ${event.id.slice(0, 8)} kind=${event.kind} created_at=${event.created_at}`,
        );
        void handleWrap(pool, relays, transport, event);
      },
      oneose: () => console.log("nostr-bridge: subscription reached EOSE (live tail)"),
    },
  );

  startWatchdog(pool, relays);
}
