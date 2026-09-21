import { SMTPServer } from "smtp-server";
import { lookupNip05 } from "./nip05.js";
import { UserResolver } from "./user-resolver.js";
import { publishMail } from "./nostr-publisher.js";
import { stripAttachments } from "./stripAttachments.js";
import { keySigner } from "./protocol/key-signer.js";
import { bytesToMessageString, messageStringToBytes } from "./protocol/bytes.js";
import { config } from "./config.js";

const bridgeSigner = keySigner(config.bridgePrivkey);

/**
 * Buffer cap for one inbound message. See `config.maxMessageBytes`.
 *
 * Peak memory per message is a multiple of this: the raw bytes are buffered,
 * then converted to a byte string, then (on the retry path) parsed and rebuilt
 * — so the cap is deliberately conservative.
 */
const MAX_MESSAGE_BYTES = config.maxMessageBytes;

/**
 * Largest raw message worth attempting as a full wrap.
 *
 * Derived in config from the relay event cap and the measured wrap inflation
 * (~2.4x). Above this the event exceeds the cap of most relays — only the
 * permissive few would accept it — and (measured 2026-09-21) building one for
 * a large attachment is what OOM-killed the 128 MB container: sealing holds
 * the content as several full-size strings (byte string → rumor JSON → seal
 * ciphertext → outer ciphertext) before encryption. Such mail goes straight
 * to the strip-attachments fallback instead.
 */
const MAX_WRAPPABLE_MESSAGE_BYTES = config.maxWrappableMessageBytes;

export class LmtpError extends Error {
  constructor(
    message: string,
    public responseCode: number,
  ) {
    super(message);
  }
}

export function createLmtpServer(userResolver: UserResolver): SMTPServer {
  return new SMTPServer({
    lmtp: true,
    secure: false,
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      let received = 0;
      let tooLarge = false;
      stream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        // Memory guard: buffering an unbounded message is how a multi-GB
        // attachment OOM-kills the process (observed as "the server crashed
        // during a large-attachment test"). Once past the cap, stop buffering
        // and keep draining so the peer can finish the transfer.
        if (received > MAX_MESSAGE_BYTES) {
          if (!tooLarge) {
            tooLarge = true;
            const mailFrom = session.envelope.mailFrom;
            console.error(
              `nostr-bridge: message exceeds ${MAX_MESSAGE_BYTES} bytes, discarding further data (from ${
                mailFrom ? mailFrom.address : "unknown"
              })`,
            );
          }
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", (err) => {
        console.error("nostr-bridge: LMTP data stream error:", (err as Error).message);
      });
      stream.on("end", () => {
        // 552 (exceeded storage allocation) is permanent and bounces to the
        // sender immediately; 451 would make Postfix re-send the same
        // oversized message on every retry.
        if (tooLarge) {
          callback(
            Object.assign(new Error("5.3.4 Message too large for this bridge"), {
              responseCode: 552,
            }),
          );
          return;
        }
        void handleMessage(
          Buffer.concat(chunks),
          session.envelope.rcptTo[0]?.address,
          userResolver,
        )
          .then(() => callback())
          .catch((err) => {
            const responseCode =
              err instanceof LmtpError ? err.responseCode : 451;
            const e = new Error(
              err instanceof Error ? err.message : "Internal error",
            ) as Error & {
              responseCode: number;
            };
            e.responseCode = responseCode;
            callback(e);
          });
      });
    },
  });
}

// Exported (module scope, not a closure over createLmtpServer's userResolver)
// so it can be tested directly against stubbed dependencies rather than
// through the SMTPServer/LMTP transport.
export async function handleMessage(
  raw: Buffer,
  recipient: string | undefined,
  userResolver: UserResolver,
): Promise<void> {
  if (!recipient) throw new LmtpError("5.1.1 No recipient", 550);

  const lookup = await lookupNip05(recipient, config.nip05BaseUrl);

  // Permanent vs transient must stay distinct: 550 bounces to the real
  // sender, 451 makes Postfix retry. Treating an outage as 550 loses mail.
  if (lookup.status === "error") {
    console.error(`nostr-bridge: NIP-05 lookup failed for ${recipient}: ${lookup.message}`);
    throw new LmtpError("4.3.0 NIP-05 lookup failed", 451);
  }
  if (lookup.status === "not-found") {
    throw new LmtpError("5.1.1 Recipient not registered", 550);
  }

  const relays = await userResolver.getDmRelays(lookup.pubkey);

  // `raw` is a Buffer (a Uint8Array) — convert to the byte-string
  // representation, NOT text-decode it. Mail declares its own charset in
  // Content-Type; decoding as UTF-8 here would corrupt any message that
  // isn't UTF-8 (ISO-8859-1, Shift-JIS, ...) before the parser ever sees
  // the declared charset. See docs/ARCHITECTURE.md §4.
  const messageRaw = bytesToMessageString(raw);

  const outcome = await publishWithAttachmentFallback(recipient, lookup.pubkey, messageRaw, relays);
  if (outcome === "too-large") {
    // Permanent: the message cannot fit a wrap the relays accept, and no
    // amount of Postfix retrying changes its size. 552 bounces it now.
    throw new LmtpError("5.3.4 Message too large to deliver over Nostr", 552);
  }
  if (outcome === "failed") {
    // Transient: nothing was accepted, but a retry could succeed.
    throw new LmtpError("4.3.0 No relay accepted the message", 451);
  }

  console.log(
    `nostr-bridge: delivered mail for ${recipient} to ${relays.length} relay(s)` +
      (outcome === "stripped" ? " (without attachments)" : ""),
  );
}

/**
 * Publish a message, falling back to a stripped copy when the full form
 * cannot be delivered.
 *
 * Two ways the full form fails, and they are handled differently:
 *
 * 1. **Too big to attempt.** A message over `MAX_WRAPPABLE_MESSAGE_BYTES`
 *    wraps to an event the relays reject on size regardless, and building it
 *    is what OOM-killed the process. The full attempt is skipped entirely —
 *    the message goes straight to the strip path.
 * 2. **Attempted and refused.** A smaller message that a relay still rejects
 *    (e.g. a strict content cap) is stripped and retried, as before.
 *
 * Never ACK a message that reached no relay: `failed` becomes LMTP 451, so
 * Postfix retries and eventually bounces to the real sender. `too-large`
 * (nothing left to strip, still unwrappable) is 552 instead — permanent, so
 * the sender is told now rather than after days of retries.
 */
async function publishWithAttachmentFallback(
  recipient: string,
  recipientPubkey: string,
  messageRaw: string,
  relays: string[],
): Promise<"full" | "stripped" | "failed" | "too-large"> {
  const publish = async (raw: string): Promise<boolean> => {
    try {
      return await publishMail({ raw, recipientPubkey, signer: bridgeSigner, relays });
    } catch (error) {
      console.error("nostr-bridge: publish threw:", (error as Error).message);
      return false;
    }
  };

  if (messageRaw.length <= MAX_WRAPPABLE_MESSAGE_BYTES) {
    if (await publish(messageRaw)) return "full";
  } else {
    console.warn(
      `nostr-bridge: message for ${recipient} is ${messageRaw.length} bytes, over the ` +
        `${MAX_WRAPPABLE_MESSAGE_BYTES}-byte wrap ceiling; skipping the full publish`,
    );
  }

  let stripped: string | null = null;
  try {
    stripped = await stripAttachments(Buffer.from(messageStringToBytes(messageRaw)));
  } catch (error) {
    console.error("nostr-bridge: stripping attachments failed:", (error as Error).message);
  }
  if (stripped === null) {
    // Nothing strippable. If the original cannot fit a wrap either, this is
    // permanent; otherwise it is a relay refusal a retry may survive.
    return messageRaw.length > MAX_WRAPPABLE_MESSAGE_BYTES ? "too-large" : "failed";
  }

  // A stripped message that is still over the ceiling (a huge body, not an
  // attachment) cannot be delivered either.
  if (stripped.length > MAX_WRAPPABLE_MESSAGE_BYTES) return "too-large";

  console.warn(
    `nostr-bridge: no relay accepted mail for ${recipient}; retrying without attachments`,
  );
  return (await publish(stripped)) ? "stripped" : "failed";
}
